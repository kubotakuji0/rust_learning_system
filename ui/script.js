// ====== 設定 ======
const STARTER_CODE = [
  'fn main() {',
  '    let mut s1 = String::from("hello");',
  '    // 以下の範囲だけ編集できます（3行目〜println!の直前まで）',
  '    println!("{}.", s1);',
  '}',
  '',
  'fn add_world(s: &mut String){',
  '    s.push_str(" world");',
  '}',
].join('\n');

const EDITABLE_START_LINE = 3; // 上2行は編集不可
const EXPECTED_STDOUT = "hello world.\n"; // 期待出力（末尾改行OK）

// ====== 起動 ======
require(['vs/editor/editor.main'], () => {
  const container = document.getElementById('editor');

  const editor = monaco.editor.create(container, {
    value: STARTER_CODE,
    language: 'rust',
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono"',
    fontSize: 14,
    minimap: { enabled: false },
    scrollBeyondLastLine: false
  });

  // DOM
  const runBtn = document.getElementById('runBtn');
  const resetBtn = document.getElementById('resetBtn');
  const outputEl = document.getElementById('output');
  const statusEl = document.getElementById('status');

  // 状態
  let decorations = [];
  let suppressReentry = false;

  // ====== ユーティリティ ======
  const normalize = (s) => (s ?? "").replace(/\r\n/g, "\n");
  const setStatus = (kind, text) => {
    statusEl.textContent = text;
    statusEl.classList.remove('badge-idle','badge-ok','badge-warn','badge-err');
    statusEl.classList.add(
      kind === 'ok' ? 'badge-ok' :
      kind === 'warn' ? 'badge-warn' :
      kind === 'err' ? 'badge-err' : 'badge-idle'
    );
  };

  function findPrintlnLine() {
    // 先頭から最初の println! を探す（毎回最新の位置を採用）
    const model = editor.getModel();
    const n = model.getLineCount();
    for (let i = 1; i <= n; i++) {
      const line = model.getLineContent(i);
      if (line.includes('println!')) return i;
    }
    return n + 1; // もし無ければ最下まで編集可（想定外だけど安全側）
  }

  function allowedRange() {
    const model = editor.getModel();
    const n = model.getLineCount();
    const bottomStart = Math.min(findPrintlnLine(), n+1);
    const startLine = Math.min(EDITABLE_START_LINE, n);
    const endLine = Math.max(startLine, bottomStart - 1);
    return { startLine, endLine };
  }

  function updateDecorations() {
    const model = editor.getModel();
    const n = model.getLineCount();
    const { startLine, endLine } = allowedRange();

    const ranges = [];
    if (startLine > 1) {
      ranges.push({ range: new monaco.Range(1,1, Math.max(1,startLine-1), model.getLineMaxColumn(Math.max(1,startLine-1))), options:{ isWholeLine:true, className:'readonlyTop' }});
    }
    // editable 可視化
    ranges.push({ range: new monaco.Range(startLine,1, Math.max(startLine,endLine), model.getLineMaxColumn(Math.max(startLine,endLine))), options:{ isWholeLine:true, className:'editableArea' }});
    // println! 行以降
    const printlnLine = findPrintlnLine();
    if (printlnLine <= n) {
      ranges.push({ range: new monaco.Range(printlnLine,1, n, model.getLineMaxColumn(n)), options:{ isWholeLine:true, className:'readonlyBottom' }});
    }

    decorations = editor.deltaDecorations(decorations, ranges);
  }

  function changeTouchesReadOnly(changes) {
    const { startLine, endLine } = allowedRange();
    for (const c of changes) {
      const sL = c.range.startLineNumber;
      const eL = c.range.endLineNumber;
      // 範囲外（上2行／println!行以降）に触れているか？
      if (eL < startLine || sL >= (endLine + 1)) return true;
    }
    return false;
  }

  // 編集可能範囲（3行目〜 println! の直前）だけを見て "add_world" を検出
  function usedAddWorld() {
  const model = editor.getModel();
  const { startLine, endLine } = allowedRange();
  
  // 範囲からテキストを抜き出す
  const text = model.getValueInRange(new monaco.Range(
    startLine, 1,
    endLine, model.getLineMaxColumn(endLine)
  ));

  // ほんとうにシンプルに「文字列があるか」だけを見る（呼び出し/定義/コメントの区別はしない）
  return /\badd_world\b/.test(text);
}

  function showOutput(s) {
    outputEl.textContent = s ?? "";
  }

  // ====== ガード（編集制御） ======
  updateDecorations();

  // 3行目 先頭でのBackspace禁止
  editor.onKeyDown((e) => {
    const pos = editor.getPosition();
    if (!pos) return;
    if (e.keyCode === monaco.KeyCode.Backspace && pos.lineNumber === EDITABLE_START_LINE && pos.column === 1) {
      e.preventDefault(); e.stopPropagation();
      setStatus('warn', '3行目の先頭ではBackspaceできないよ');
    }
  });

  // 範囲外書き換えは即座に元に戻す
  editor.onDidChangeModelContent((ev) => {
    if (suppressReentry) return;
    if (changeTouchesReadOnly(ev.changes)) {
      suppressReentry = true;
      editor.undo(); // 直前の変更を打ち消す
      suppressReentry = false;
      setStatus('warn', '編集できるのは3行目〜println!の直前までだよ');
    }
    updateDecorations();
  });

  // ====== 実行系 ======
  async function run() {
    setStatus('idle', '実行中…');
    showOutput('');

    const code = editor.getValue();
    let resp;
    try {
      const r = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      resp = await r.json();
    } catch (e) {
      setStatus('err', '通信エラー');
      showOutput(String(e));
      return;
    }

    const combined = resp?.output ?? (normalize(resp?.stdout) + normalize(resp?.stderr));
    showOutput(combined);

        // 判定
    if (resp?.timed_out) {
      setStatus('err', 'タイムアウト（2s）');
      return;
    }
    if (resp?.compiled === false) {
      setStatus('err', 'コンパイルエラー');
      return;
    }
    const okOut = normalize(combined) === normalize(EXPECTED_STDOUT);
    const used = usedAddWorld();

    if (!used) {
      setStatus('warn', 'add_world未使用');
    } else if (!okOut) {
      setStatus('warn', '出力不一致');
    } else {
      setStatus('ok', '正解！');
    }
  }

  // ====== ボタン & ショートカット ======
  runBtn.addEventListener('click', run);
  resetBtn.addEventListener('click', () => {
    if (!confirm('本当にリセットしますか？\n（編集内容は元に戻せません）')) return;
    editor.setValue(STARTER_CODE);
    editor.setPosition({ lineNumber: EDITABLE_START_LINE, column: 1 });
    showOutput('');
    setStatus('idle', '準備OK');
    updateDecorations();
  });
  // Ctrl/⌘ + Enter で実行
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

  // 初期フォーカス
  editor.focus();
  editor.setPosition({ lineNumber: EDITABLE_START_LINE, column: 1 });
});