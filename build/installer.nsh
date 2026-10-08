!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

; ------------------------------------------------------------------
; 安装/卸载时默认展开详细日志（2026-10-06 用户要求，2026-10-08 再次强调）
;
; NSIS 默认把文件列表折叠起来，只显示一个进度条；出问题时（某个文件被占用
; 删不掉、覆盖失败）用户完全看不出卡在哪一步。show 让 Details 面板默认展开。
;
; ⚠️ 本软件**不再用静默安装**（`/S` 在实机上出过「提权进程秒退、安装根本没
;    发生、界面零反馈」的不可观测失败），所以这里对所有安装路径都生效。
;    出错时能直接看到卡在哪个文件，不必再去翻日志。
; ------------------------------------------------------------------
ShowInstDetails show
ShowUninstDetails show

; ------------------------------------------------------------------
; 安装完成后拉起新版本（**仅限用户手动选择静默安装的那条路径**）
;
; ⚠️ 2026-10-08 现状：软件内点「安装」走的是**普通权限 shell.openPath**，
;    安装包自己弹 UAC、用户手点一路完成（与用户手动双击完全一致）。
;    这种交互式安装由 electron-builder 自带的完成页「运行」按钮负责拉起
;    （走 StdUtils.ExecShellAsUser，不带管理员权限）。
;    本段只保留给「用户自己右键安装包 → 选静默安装」——
;    静默模式不走完成页，装完就悄无声息，需要这里兜一下。
;    **交互模式下绝不执行本段**，否则会和完成页的「运行」把程序开两遍。
;
; 为什么用 ExecShell 而不是 Exec：Exec 会继承安装包的管理员权限，导致软件
;    长期以管理员身份运行（不该这样）；ExecShell "open" 走 ShellExecute，
;    由资源管理器按当前用户环境拉起。
; ------------------------------------------------------------------
!macro customInstall
  ${If} ${Silent}
    ExecShell "open" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend

; ------------------------------------------------------------------
; 自定义卸载欢迎页：复选框决定是否删除个人数据
; （默认不勾选 = 保留数据；覆盖安装升级时旧卸载器以 /S --updated
;   静默执行，页面不显示，$unDeleteMyData 保持 0，绝不会误删数据）
;
; 注意：本文件被 electron-builder 前置到脚本最顶部（早于 MUI2），
; 所以不能使用 MUI_HEADER_TEXT 宏——页眉文字在页面 Pre 回调里
; 按 MUI2 固定控件 ID（1219 标题 / 1220 副标题）运行时写入。
; ------------------------------------------------------------------

!ifdef BUILD_UNINSTALLER
Var unDataDialog
Var unDeleteDataCheck
Var unDeleteMyData
!endif

; un.onInit 末尾插入：默认保留数据；显式带 --delete-app-data 时删除
!macro customUnInit
  StrCpy $unDeleteMyData "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $unDeleteMyData "1"
  ${EndIf}
!macroend

; 替换 electron-builder 默认的卸载欢迎页
!macro customUnWelcomePage
  UninstPage custom un.UnDataPagePre un.UnDataPageLeave
!macroend

!ifdef BUILD_UNINSTALLER
Function un.UnDataPagePre
  ; 页眉（MUI2 现代界面固定控件 ID）
  GetDlgItem $R0 $HWNDPARENT 1219
  SendMessage $R0 ${WM_SETTEXT} 0 "STR:卸载 MS Rewards Auto"
  GetDlgItem $R1 $HWNDPARENT 1220
  SendMessage $R1 ${WM_SETTEXT} 0 "STR:选择是否同时删除您的个人数据"

  nsDialogs::Create 1018
  Pop $unDataDialog
  ${If} $unDataDialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 60u \
    "欢迎使用 MS Rewards Auto 卸载向导。$\r$\n$\r$\n点击「卸载」将从本机移除程序文件。您的账户数据（加密保险库、登录态与各项设置）默认保留在本机，以后重新安装可继续使用。"
  Pop $0

  ${NSD_CreateCheckbox} 0 68u 100% 14u \
    "同时删除我的账户数据（保险库、账户登录态与全部设置），此操作不可恢复"
  Pop $unDeleteDataCheck
  ${NSD_SetState} $unDeleteDataCheck ${BST_UNCHECKED}

  nsDialogs::Show
FunctionEnd

Function un.UnDataPageLeave
  ${NSD_GetState} $unDeleteDataCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $unDeleteMyData "1"
  ${Else}
    StrCpy $unDeleteMyData "0"
  ${EndIf}
FunctionEnd
!endif

; 卸载主 Section 内：按复选框状态删除 Roaming 下的数据目录。
; 路径集合与 electron-builder 模板内置的删除块保持一致。
!macro customUnInstall
  ${If} $unDeleteMyData == "1"
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
