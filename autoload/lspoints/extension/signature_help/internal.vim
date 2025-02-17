" bufnr: number
" trigger_chars: string
" retrigger_chars: string
" denops: string
" callbacks: { trigger: string, close: string }
function lspoints#extension#signature_help#internal#enable_auto_float_for_buffer(
  \ bufnr, trigger_chars, retrigger_chars, denops, callbacks) abort
  let trigger_chars = string(a:trigger_chars)
  let retrigger_chars = string(a:retrigger_chars)
  let denops = string(a:denops)
  let request_trigger = string(a:callbacks.trigger)
  let request_close = string(a:callbacks.close)
  augroup lspoints.extension.signature_help.auto_float
    execute $'autocmd! * <buffer={a:bufnr}>'
    execute $'autocmd InsertCharPre <buffer={a:bufnr}> call s:on_insert_character(' .
      \ $'{trigger_chars}, {retrigger_chars}, v:char, {denops}, {request_trigger})'
    execute $'autocmd InsertLeave <buffer={a:bufnr}> call denops#notify(' .
      \ $'{denops}, {request_close}, [])'
    execute $'autocmd InsertEnter <buffer={a:bufnr}> call denops#notify(' .
      \ $'{denops}, {request_trigger},' . '[{"kind": "contentChange"}])'
  augroup END
endfunction

function s:on_insert_character(trigger_chars, retrigger_chars, char, denops, callback) abort
  let trigger_flags = {
    \ 'kind': 'triggerCharacter',
    \ 'char': a:char,
    \ 'isTrigger': stridx(a:trigger_chars, a:char) != -1 ? v:true : v:false,
    \ 'isRetrigger': stridx(a:retrigger_chars, a:char) != -1 ? v:true : v:false,
    \ }
  if trigger_flags.isTrigger || trigger_flags.isRetrigger
    call denops#notify(a:denops, a:callback, [trigger_flags])
  else
    call denops#notify(a:denops, a:callback, [{'kind': 'contentChange'}])
  endif
endfunction
