; Added to Tauri's Windows installer (tauri.conf.json → bundle → windows →
; nsis → installerHooks).
;
; "Minuteman Contacts" in the Start menu: Minuteman with --contacts, which
; opens just Contacts, or Contacts in the Minuteman already running
; (desktop.rs OPEN_CONTACTS, and the single-instance plugin in lib.rs). Its
; icon is contacts.ico, installed beside Minuteman (bundle → resources).

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$SMPROGRAMS\Minuteman Contacts.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "--contacts" "$INSTDIR\contacts.ico" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$SMPROGRAMS\Minuteman Contacts.lnk"
!macroend
