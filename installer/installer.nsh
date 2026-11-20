; Kacha 的安装器钩子：mygo.config.ts 的 windows.installerInclude 指向本文件。
;
; MyGo 生成的安装器只在最后一页给出「运行 Kacha」勾选框（MUI_FINISHPAGE_RUN），
; 而 /S 静默安装不显示任何页面，所以自动更新这样装完，应用不会自己起来。
; 这里补这一步：装完之后由安装器自己启动 $INSTDIR\Kacha.exe。
; 安装器此时已经写完文件，不用另起一个等安装器退出的进程去抢 exe。
;
; 只有命令行带 --relaunch 时才启动：desktop/internal/updateservice 的 Install
; 传这个参数（那里的 relaunchFlag），别的静默安装（装机脚本、批量部署）
; 不会突然弹出应用。这个字面量两端必须一致，packaging/tests 有测试锁住。

!include "FileFunc.nsh"

Var KachaRelaunch

; 记下命令行里有没有 --relaunch，下面的安装段读它。
!macro customInit
  StrCpy $KachaRelaunch "0"
  ${GetParameters} $R0
  ${GetOptions} $R0 "--relaunch" $R1
  IfErrors kachaNoRelaunch 0
    StrCpy $KachaRelaunch "1"
  kachaNoRelaunch:
!macroend

!macro customInstall
; Exec 是发射后不管：nsExec::Exec 会等应用退出，常驻的 GUI 会让安装器一直不结束。
; 交互安装由完成页的勾选框启动，这里只在静默安装里补上，避免同时开两个实例。
  StrCmp $KachaRelaunch "1" 0 kachaRelaunchDone
  IfSilent 0 kachaRelaunchDone
  Exec '"$INSTDIR\Kacha.exe"'
  kachaRelaunchDone:
!macroend
