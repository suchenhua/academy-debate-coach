' =========================================================
'  Academy 辩论教练 - FLASH launcher (isolated port)
'
'  Why this file exists:
'    Pro and Flash ship as two separate copies. Both default to
'    port 8787, and the launcher reuses whatever server it finds
'    there. So if Pro is already running, opening Flash shows the
'    PRO interface -- the symptom was 'every desktop shortcut opens
'    the Pro version'.
'
'  This wrapper only sets ACADEMY_PORT=8790 so Flash never shares a
'  port with Pro. It does NOT modify any Flash source file.
'  (The Pro copy additionally got an identity check in its own
'  launcher, so it will not reuse a foreign server either.)
'
'  Pure ASCII so it parses identically on any codepage.
' =========================================================
Option Explicit

Dim sh, fso, base, exe, script
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

exe    = base & "\runtime\electron\dist\electron.exe"
script = base & "\app\electron-main.js"

If fso.FileExists(exe) And fso.FileExists(script) Then
  ' Process-level env: inherited by Electron and the server it spawns
  sh.Environment("PROCESS")("ACADEMY_PORT") = "8790"
  sh.Run Chr(34) & exe & Chr(34) & " " & Chr(34) & script & Chr(34), 1, False
Else
  MsgBox "Academy Debate Coach (Flash): runtime not found." & vbCrLf & _
         "Please check the app folder.", 48, "Academy"
End If
