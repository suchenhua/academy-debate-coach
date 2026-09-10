' =========================================================
'  Academy Debate Coach - ELECTRON DESKTOP launcher (default)
'  Pure ASCII so it parses identically on any codepage.
' =========================================================
Option Explicit

Dim sh, fso, base, exe, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

exe    = base + "\runtime\electron\dist\electron.exe"
script = base + "\app\electron-main.js"

If fso.FileExists(exe) And fso.FileExists(script) Then
  sh.Run Chr(34) + exe + Chr(34) + " " + Chr(34) + script + Chr(34), 1, False
Else
  MsgBox "Academy Debate Coach: Electron runtime not found." + vbCrLf + _
         "Please reinstall or check the app folder.", 48, "Academy"
End If
