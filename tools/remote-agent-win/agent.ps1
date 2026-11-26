# DSH 远程协助 · Windows 简版客户端
# 作用：向服务器建立一条"出站"加密连接；服务器可经此下发命令并取回输出。
# 特点：不需要在路由器/防火墙做端口映射，不需要管理员权限，不需要安装。
$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------- 配置（换成你自己的服务器信息） ----------------
$Server   = 'wss://tnty.9017i.cc:19306/agent'
$User     = 'dsh'
$Pass     = '__PASSWORD__'   # 换成你的 BasicAuth 密码
$Version  = 'simple-1.0'
# ----------------------------------------------------------------

$HostName = $env:COMPUTERNAME
$BaseDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogFile  = Join-Path $BaseDir 'agent.log'
$PidFile  = Join-Path $BaseDir 'agent.pid'

function Log([string]$msg) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

function Send-Ws($ws, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $seg = [System.ArraySegment[byte]]::new($bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
}

function Run-Command([string]$cmd, [int]$timeoutMs) {
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('dsh-agent-' + [Guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $wrapper = Join-Path $tmp 'run.ps1'
  $outFile = Join-Path $tmp 'stdout.txt'
  $errFile = Join-Path $tmp 'stderr.txt'
  $head = @'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try {
'@
  $tail = @'
  if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
'@
  $content = $head + "`r`n" + $cmd + "`r`n" + $tail
  [IO.File]::WriteAllText($wrapper, $content, [System.Text.UTF8Encoding]::new($false))
  $code = 0
  $errExtra = ''
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $wrapper + '"'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.WorkingDirectory = $env:USERPROFILE
    try {
      $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
      $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    } catch {}
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $done = $p.WaitForExit([Math]::Max(1000, $timeoutMs))
    if (-not $done) {
      try { $p.Kill() } catch {}
      $code = -1
      $errExtra = "[命令超时，已强制结束]"
    } else {
      $code = $p.ExitCode
    }
    $stdout = ''
    $stderr = ''
    try { $stdout = [string]$outTask.Result } catch {}
    try { $stderr = [string]$errTask.Result } catch {}
    try { $p.Dispose() } catch {}
  } catch {
    $code = -1
    $stdout = ''
    $stderr = ''
    $errExtra = '启动命令失败: ' + $_.Exception.Message
  } finally {
    try { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } catch {}
  }
  if ($stdout.Length -gt 1000000) { $stdout = $stdout.Substring(0, 1000000) + "`r`n[输出过长已截断]" }
  if ($stderr.Length -gt 200000)  { $stderr = $stderr.Substring(0, 200000) + "`r`n[错误输出过长已截断]" }
  return @{ code = $code; stdout = [string]$stdout; stderr = ([string]$stderr + $errExtra) }
}

function Handle-Exec($ws, $m) {
  $timeout = 60000
  try { if ($m.timeoutMs) { $timeout = [Math]::Min(600000, [int]$m.timeoutMs) } } catch {}
  Log ('收到命令: ' + ([string]$m.cmd).Substring(0, [Math]::Min(120, ([string]$m.cmd).Length)))
  $r = Run-Command ([string]$m.cmd) $timeout
  $res = @{ type = 'result'; id = $m.id; ok = $true; code = $r.code; stdout = $r.stdout; stderr = $r.stderr }
  try { Send-Ws $ws ($res | ConvertTo-Json -Compress -Depth 5) } catch { Log ('回传结果失败: ' + $_.Exception.Message) }
  Log ('命令完成，退出码 ' + $r.code)
}

# 记录 PID，方便"停止.bat"结束
try { Set-Content -Path $PidFile -Value $PID -Encoding ASCII } catch {}

$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($User + ':' + $Pass)))
$info = @{
  os      = [Environment]::OSVersion.VersionString
  user    = $env:USERNAME
  version = $Version
  computer = $HostName
}

Log ('DSH 远程协助简版客户端启动，主机名: ' + $HostName)
while ($true) {
  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.SetRequestHeader('Authorization', ('Basic ' + $auth))
  try { $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(25) } catch {}
  $connected = $false
  try {
    $task = $ws.ConnectAsync([Uri]$Server, [Threading.CancellationToken]::None)
    if (-not $task.Wait(20000)) { throw '连接超时' }
    $connected = ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open)
  } catch {
    Log ('连接失败: ' + $_.Exception.Message)
  }
  if ($connected) {
    Log '已连接到服务器中继'
    try { Send-Ws $ws ( (@{ type = 'hello'; host = $HostName; info = $info }) | ConvertTo-Json -Compress -Depth 5 ) } catch { Log ('握手失败: ' + $_.Exception.Message); $connected = $false }
  }
  if ($connected) {
    $buf = New-Object byte[] 65536
    $sb = New-Object System.Text.StringBuilder
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      try {
        $seg = [System.ArraySegment[byte]]::new($buf)
        $r = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      } catch {
        Log ('连接中断: ' + $_.Exception.Message)
        break
      }
      if ($r.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { Log '服务器关闭了连接'; break }
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
      if (-not $r.EndOfMessage) { continue }
      $json = $sb.ToString()
      [void]$sb.Clear()
      if ([string]::IsNullOrWhiteSpace($json)) { continue }
      $m = $null
      try { $m = $json | ConvertFrom-Json } catch { Log '收到无法解析的消息'; continue }
      if ($m.type -eq 'welcome') { Log '服务器已确认连接，等待命令…'; continue }
      if ($m.type -eq 'exec') { Handle-Exec $ws $m; continue }
    }
  }
  try { $ws.Dispose() } catch {}
  Log '连接已断开，5 秒后自动重连（关闭本窗口即退出）…'
  Start-Sleep -Seconds 5
}
