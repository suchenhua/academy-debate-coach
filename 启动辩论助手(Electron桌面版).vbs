' =====================================================
'  Academy Debate Coach - ELECTRON DESKTOP launcher
'  Pure ASCII so it parses identically on any codepage.
'
'  Double-click this file to open a real desktop window
'  built on Electron (bundled Chromium). No console,
'  no browser tabs, close window = quit app.
' =====================================================
Option Explicit

Dim sh, fso, base, exe, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

exe    = base & "\runtime\electron\dist\electron.exe"
script = base & "\app\electron-main.js"

' window style 1 = SW_SHOWNORMAL: Electron is a GUI app and the
' window must be shown normally. Style 0 makes Electron hide its
' window. False = do not wait for it to exit.
If fso.FileExists(exe) And fso.FileExists(script) Then
  sh.Run Chr(34) & exe & Chr(34) & " " & Chr(34) & script & Chr(34), 1, False
Else
  MsgBox "Academy Debate Coach: Electron runtime not found." & vbCrLf & _
         "Please reinstall or check the app folder.", 48, "Academy"
End If