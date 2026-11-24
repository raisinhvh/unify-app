; Custom NSIS hooks for the Windows installer (electron-builder includes this via nsis.include).
; Show the file list while installing, so a long step is visibly progressing instead of looking stuck.
!macro customHeader
  ShowInstDetails show
!macroend
