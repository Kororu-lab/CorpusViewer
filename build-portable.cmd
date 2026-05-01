@ECHO OFF
SETLOCAL

SET "NPM_CLI=C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"
IF NOT EXIST "%NPM_CLI%" (
  ECHO Cannot find npm CLI at "%NPM_CLI%".
  EXIT /B 1
)

node "%NPM_CLI%" run package
EXIT /B %ERRORLEVEL%
