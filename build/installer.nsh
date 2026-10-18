; Windows installer extras (included by electron-builder, see electron-builder.yml → nsis.include).
; Adds a "Which operating systems do you want?" page. The picks are saved to
; %APPDATA%\Ultimate VMs\first-run.json, and the app sets each one up (Quick Setup) on its first launch.
; electron-builder also compiles the uninstaller from this file, which has no such page.
!ifndef BUILD_UNINSTALLER
!include nsDialogs.nsh
!include LogicLib.nsh

Var UvmDialog
Var UvmPicks
Var UvmCbWin11
Var UvmCbWin10
Var UvmCbUbuntu
Var UvmCbFedora
Var UvmCbDebian
Var UvmCbMint
Var UvmCbChrome

!macro customPageAfterChangeDir
  Page custom UvmOsPage UvmOsPageLeave
!macroend

Function UvmOsPage
  nsDialogs::Create 1018
  Pop $UvmDialog
  ${If} $UvmDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 30u "Which operating systems do you want? Ultimate VMs downloads and installs each one by itself the first time it opens. You can add more later."
  Pop $0

  ${NSD_CreateCheckbox} 0 36u 48% 12u "Windows 11"
  Pop $UvmCbWin11
  ${NSD_CreateCheckbox} 0 52u 48% 12u "Windows 10"
  Pop $UvmCbWin10
  ${NSD_CreateCheckbox} 0 68u 48% 12u "ChromeOS Flex"
  Pop $UvmCbChrome
  ${NSD_CreateCheckbox} 52% 36u 48% 12u "Ubuntu"
  Pop $UvmCbUbuntu
  ${NSD_CreateCheckbox} 52% 52u 48% 12u "Fedora Workstation"
  Pop $UvmCbFedora
  ${NSD_CreateCheckbox} 52% 68u 48% 12u "Debian"
  Pop $UvmCbDebian
  ${NSD_CreateCheckbox} 52% 84u 48% 12u "Linux Mint"
  Pop $UvmCbMint

  ${NSD_CreateLabel} 0 106u 100% 24u "Windows installs with no product key and no Microsoft account. Linux logs in as user / password user. (macOS is available in the Mac version.)"
  Pop $0

  nsDialogs::Show
FunctionEnd

!macro UvmPick CHECKBOX ID
  ${NSD_GetState} ${CHECKBOX} $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $UvmPicks '$UvmPicks"${ID}",'
  ${EndIf}
!macroend

Function UvmOsPageLeave
  StrCpy $UvmPicks ""
  !insertmacro UvmPick $UvmCbWin11 "windows11"
  !insertmacro UvmPick $UvmCbWin10 "windows10"
  !insertmacro UvmPick $UvmCbUbuntu "ubuntu"
  !insertmacro UvmPick $UvmCbFedora "fedora"
  !insertmacro UvmPick $UvmCbDebian "debian"
  !insertmacro UvmPick $UvmCbMint "mint"
  !insertmacro UvmPick $UvmCbChrome "chromeos"
FunctionEnd

!macro customInstall
  ${If} $UvmPicks != ""
    ; The signed-in user's own AppData (the installer may be running for all users).
    ReadEnvStr $1 APPDATA
    CreateDirectory "$1\Ultimate VMs"
    FileOpen $2 "$1\Ultimate VMs\first-run.json" w
    FileWrite $2 '{"quick":[$UvmPicks"end"]}'
    FileClose $2
  ${EndIf}
!macroend
!endif
