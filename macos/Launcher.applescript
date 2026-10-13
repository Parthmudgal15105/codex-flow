on run
    set actions to {"Open a project", "Check account usage", "Sign in to Account A", "Sign in to Account B", "Continue unfinished work"}
    set chosenActions to choose from list actions with title "Codex Flow" with prompt "What would you like to do?" default items {"Open a project"}
    if chosenActions is false then return
    set actionName to item 1 of chosenActions
    set nodePath to "/Users/parthmudgal/.nvm/versions/node/v24.21.0/bin/node"
    set cliPath to "/Users/parthmudgal/Code/ParthProject/codex-flow/src/cli.js"
    set baseCommand to "env PATH=/Users/parthmudgal/.nvm/versions/node/v24.21.0/bin:/usr/bin:/bin:/usr/sbin:/sbin CODEX_FLOW_CODEX=" & quoted form of "/Users/parthmudgal/.nvm/versions/node/v24.21.0/bin/codex" & " " & quoted form of nodePath & " " & quoted form of cliPath
    if actionName is "Sign in to Account A" then
        set terminalCommand to baseCommand & " login a"
    else if actionName is "Sign in to Account B" then
        set terminalCommand to baseCommand & " login b"
    else if actionName is "Check account usage" then
        set terminalCommand to baseCommand & " status"
    else
        set projectFolder to choose folder with prompt "Choose your coding project's folder"
        set projectPath to POSIX path of projectFolder
        if actionName is "Continue unfinished work" then
            set terminalCommand to baseCommand & " continue " & quoted form of projectPath
        else
            set terminalCommand to baseCommand & " start " & quoted form of projectPath
        end if
    end if
    tell application "Terminal"
        activate
        do script terminalCommand
    end tell
end run
