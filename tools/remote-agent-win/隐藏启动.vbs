' 后台运行（无窗口）。停止：双击「停止.bat」或在任务管理器结束 powershell.exe
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\agent.ps1""", 0, False
