Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\User\OneDrive\Desktop\kalshi-bot"
WshShell.Run "node index.js", 0, False
