//AMDローダの読み込み確認
if (typeof require === 'undefined') {
  console.warn('[Monaco] AMD loader がまだ読み込まれていません');
}
//AMDローダにパス設定を渡す
require.config({
  paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }
});

//Monacoの読み込み
require(['vs/editor/editor.main'], function () {
  //初期コード
  const originalCode = `fn main() {
    let mut s1 = String::from("hello");
    // この部分を編集してください
    println!("{}.", s1);
}

fn add_world(s: &mut String) {
    s.push_str(" world");
}`;

  const NON_EDITABLE_TOP_LINES = 2;                 // 1〜2行目は常に編集不可
  const EDITABLE_START_LINE    = NON_EDITABLE_TOP_LINES + 1; // 3行目から編集可
  const expectedStdout = 'hello world.\n';

  const lines = originalCode.split('\n');
  let endIndex = lines.findIndex(l => l.includes('println!("{}.", s1)'));
  if (endIndex === -1) endIndex = lines.length - 1; // 保険
  const fixedBottom = lines.slice(endIndex); // println! を含む行〜末尾

  //Monacoエディタ生成
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value: originalCode,
    language: 'rust',
    theme: 'vs-dark',
    automaticLayout: true,
  });
  const model = editor.getModel();

  // 編集可能範囲のハイライト
  let decorations = [];
  function bottomStartLine() { // 1始まりの println! 行
    const cur = model.getLinesContent();
    return (cur.length - fixedBottom.length + 1);
  }

  function updateEditableDecoration() {
    const endLine = Math.max(EDITABLE_START_LINE, bottomStartLine() - 1);
    decorations = editor.deltaDecorations(decorations, [{
      range: new monaco.Range(EDITABLE_START_LINE, 1, endLine, 1),
      options: { isWholeLine: true, className: 'editable-range', inlineClassName: 'editable-range' },
    }]);
  }
  
  updateEditableDecoration();

  function isEditingKey(k) {
    const nav = new Set([
      monaco.KeyCode.LeftArrow,
      monaco.KeyCode.RightArrow,
      monaco.KeyCode.UpArrow,
      monaco.KeyCode.DownArrow,
      monaco.KeyCode.Home,
      monaco.KeyCode.End,
      monaco.KeyCode.PageUp,
      monaco.KeyCode.PageDown
    ]);
    if (nav.has(k)) return false;

    return (
      k === monaco.KeyCode.Backspace ||
      k === monaco.KeyCode.Delete   ||
      k === monaco.KeyCode.Enter    ||
      k === monaco.KeyCode.Tab      ||
      (k >= monaco.KeyCode.Space && k <= monaco.KeyCode.KeyZ)
    );
  }

  editor.onKeyDown(function (e) {
    const pos    = editor.getPosition();
    const line   = pos.lineNumber;
    const column = pos.column;
    const bottomLine = bottomStartLine();
    //上２行で編集キー
    if (line <= NON_EDITABLE_TOP_LINES && isEditingKey(e.keyCode)) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
    //３行目左端でバックスペースキー
    if (line === EDITABLE_START_LINE && column === 1 && e.keyCode === monaco.KeyCode.Backspace) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
    //下部の編集不可領域での編集キー
    if (line >= bottomLine && isEditingKey(e.keyCode)) {
      e.preventDefault(); e.stopPropagation();
      return;
    }
  });

  editor.onDidChangeModelContent(function () {
    const cur   = model.getLinesContent();
    const edits = [];
    const offset = cur.length - fixedBottom.length;
    for (let i = 0; i < fixedBottom.length; i++) {
      const idx = offset + i;
      if (cur[idx] !== fixedBottom[i]) {
        const range = new monaco.Range(idx + 1, 1, idx + 1, model.getLineMaxColumn(idx + 1));
        edits.push({ range, text: fixedBottom[i], forceMoveMarkers: true });
      }
    }
    if (edits.length) {
      editor.executeEdits(null, edits);
    }
    updateEditableDecoration();
  });

  // UI 要素
  const $btnRun  = document.getElementById('runBtn');
  const $btnReset= document.getElementById('resetBtn');
  const $status  = document.getElementById('status');
  const $output  = document.getElementById('output');

  function setStatus(kind, text) { // kind: 'ok'|'warn'|'err'|'info'
  const map = { ok:'badge badge-ok', warn:'badge badge-warn', err:'badge badge-err', info:'badge badge-info' };
  $status.className = map[kind] || map.idle;
  $status.textContent = text;
}

  function normalizeOut(s) { return (s ?? '').replace(/\r\n/g, '\n'); }

  function showResult(resp) {
    // サーバ優先の combined 出力（fallback は手元結合）
    const combined = resp.output ?? ((resp.stdout ?? '') + (resp.stderr ?? ''));
    const out = normalizeOut(combined);

    $output.textContent = (out || '(empty)');

    if (!resp.compiled) { setStatus('err', 'コンパイルエラー'); return; }
    if (resp.timed_out) { setStatus('err', 'タイムアウト');   return; }

    const stdoutOnly = normalizeOut(resp.stdout ?? '');
    const okOut = stdoutOnly ? (stdoutOnly === expectedStdout) : (out === expectedStdout);

    if (!okOut) {
      setStatus('warn', '出力不一致');
    } else if (!resp.used_add_world) {
      setStatus('warn', 'add_world未使用');
    } else {
      setStatus('ok', '正解！');
    }
  }

  async function runServer() {
    try {
      setStatus('info', '実行中…');
      $btnRun.disabled = true;
      const code = editor.getValue();
      const resp = await fetch('/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const json = await resp.json();
      showResult(json);
    } catch (e) {
      setStatus('err', '通信エラー: ' + (e && e.message ? e.message : e));
    } finally {
      $btnRun.disabled = false;
    }
  }

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runServer());
  $btnRun.addEventListener('click', () => runServer());
  $btnReset.addEventListener('click', () => {
    if (confirm('コードをリセットしますか？')) {
      editor.setValue(originalCode);
      setStatus('info', 'リセットしました');
      $output.textContent = '（ここに表示されます）';
    }
  });
});