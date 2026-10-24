; Custom NSIS include for Coullseys Lucky Wheel (same as Gift Looper)
; Forces desktop + start menu shortcuts to use the bundled icon.ico,
; since signAndEditExecutable is disabled (no exe icon embedding).

!macro customInstall
  ; icon.ico is bundled into the app resources (see build.files + extraResources)
  ; Recreate shortcuts pointing their icon at the bundled .ico file.
  CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\icon.ico" 0
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\icon.ico" 0
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
!macroend
