// Keep the published harfbuzzjs subset profile small while restoring the
// outline formats Domotion embeds.  hb-config.hh applies this override before
// its option-closure pass.  Merely undefining HB_NO_SUBSET_CFF is insufficient:
// HB_TINY + HB_NO_DRAW redefines HB_NO_CFF afterward, which in turn redefines
// HB_NO_SUBSET_CFF.  Keep drawing enabled so the closure cannot discard the CFF
// parser/subsetter again.
#undef HB_NO_DRAW
#undef HB_NO_CFF
#undef HB_NO_OT_FONT_CFF
#undef HB_NO_SUBSET_CFF
#undef HB_NO_SUBSET_LAYOUT
#undef HB_NO_VAR
#undef HB_NO_STYLE
#undef HB_NO_VERTICAL
