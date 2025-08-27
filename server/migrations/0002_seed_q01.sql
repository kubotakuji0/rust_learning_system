insert into problems
(id, title, prompt_html, starter_code, expected_stdout, top_lock_lines, bottom_anchor)
values
('q01',
 'add_worldで"hello"に" world"を足す',
 'add_world関数を用いて、<code>s1</code> を <code>"hello"</code> から <code>"hello world"</code> に変えよ。',
 'fn main() {\n    let mut s1 = String::from("hello");\n    // この部分を編集してください\n    println!(\"{}.\", s1);\n}\n\nfn add_world(s: &mut String) {\n    s.push_str(\" world\");\n}',
 'hello world.\n',
 2,
 'println!(\"{}.\", s1)'
);

insert into problem_checks (problem_id, kind, pattern)
values ('q01', 'must_contain', 'add_world(');
