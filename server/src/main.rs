use actix_files::Files;
use actix_web::{
    get, post, web, App, HttpResponse, HttpServer, Responder,
    middleware::{Logger, DefaultHeaders},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{fs, process::Command, time::timeout};
use sqlx::{SqlitePool, FromRow};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous};
use chrono::Utc;

/* ==================== CSP（Monaco のための最小セット） ==================== */
const CSP: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net; ",
    "worker-src 'self' blob:; ",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ",
    "font-src 'self' data: https://cdn.jsdelivr.net; ",
    "img-src 'self' data:; ",
    "connect-src 'self';"
);

/* ==================== アプリ状態 ==================== */

#[derive(Clone)]
struct AppState {
    pool: SqlitePool,
}

/* ==================== データモデル ==================== */

#[derive(FromRow, Serialize)]
struct Problem {
    id: i64,
    slug: String,
    title: String,
    description: String,
    starter_code: String,
    expected_stdout: String,
    fixed_top: Option<String>,
    fixed_bottom: Option<String>,
    // ★ 追加: 編集範囲マーカー（NULL可）
    editable_start_marker: Option<String>,
    editable_end_marker:   Option<String>,
    created_at: String,
}

// 最小構成の submissions
#[derive(FromRow)]
struct Submission {
    id: i64,
    problem_id: i64,
    code: String,
    output: String,
    created_at: String,
}

#[derive(Deserialize)]
struct RunReq {
    problem_id: i64,
    code: String,
}

#[derive(Serialize)]
struct RunResp {
    compiled: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
    passed: bool,
    output: String,
}

/* ==================== コンパイル＆実行 ==================== */

async fn run_user_code(code: &str) -> anyhow::Result<(bool, bool, String, String)> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let work_dir = PathBuf::from(format!("/tmp/run-{}", nanos));
    fs::create_dir_all(&work_dir).await?;

    let src = work_dir.join("main.rs");
    fs::write(&src, code).await?;

    let bin = work_dir.join("app-bin");
    let compile_out = Command::new("rustc")
        .arg(&src)
        .arg("-O")
        .arg("-o")
        .arg(&bin)
        .output()
        .await?;

    if !compile_out.status.success() {
        let stderr = String::from_utf8_lossy(&compile_out.stderr).to_string();
        return Ok((false, false, String::new(), stderr));
    }

    let run_fut = Command::new(&bin).output();
    let out = match timeout(Duration::from_secs(2), run_fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Ok((true, false, String::new(), format!("exec error: {e}"))),
        Err(_) => return Ok((true, true, String::new(), String::new())),
    };

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ok((true, false, stdout, stderr))
}

/* ==================== ヘルパ：提出保存 ==================== */

async fn save_submission(pool: &SqlitePool, problem_id: i64, code: &str, output: &str) {
    if let Err(e) = sqlx::query(
        r#"
        INSERT INTO submissions (problem_id, code, output, created_at)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(problem_id)
    .bind(code)
    .bind(output)
    .bind(Utc::now().to_rfc3339())
    .execute(pool)
    .await
    {
        eprintln!("[save_submission] insert failed: {e}");
    }
}

/* ==================== ハンドラ ==================== */

#[get("/api/problems")]
async fn list_problems(state: web::Data<AppState>) -> impl Responder {
    let rows = sqlx::query_as::<_, Problem>(
        r#"
        SELECT
          id, slug, title, description, starter_code, expected_stdout,
          fixed_top, fixed_bottom,
          editable_start_marker, editable_end_marker,
          created_at
        FROM problems
        ORDER BY id
        "#,
    )
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => {
            eprintln!("[/api/problems] sqlx error: {e}");
            HttpResponse::InternalServerError().body(format!("db error: {e}"))
        }
    }
}

#[get("/api/problems/{id}")]
async fn get_problem(path: web::Path<i64>, state: web::Data<AppState>) -> impl Responder {
    let id = path.into_inner();
    let row = sqlx::query_as::<_, Problem>(
        r#"
        SELECT
          id, slug, title, description, starter_code, expected_stdout,
          fixed_top, fixed_bottom,
          editable_start_marker, editable_end_marker,
          created_at
        FROM problems
        WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await;

    match row {
        Ok(p) => HttpResponse::Ok().json(p),
        Err(sqlx::Error::RowNotFound) => HttpResponse::NotFound().finish(),
        Err(e) => {
            eprintln!("[/api/problems/{id}] sqlx error: {e}");
            HttpResponse::InternalServerError().body(format!("db error: {e}"))
        }
    }
}

#[post("/api/run")]
async fn run(req: web::Json<RunReq>, state: web::Data<AppState>) -> impl Responder {
    let p = sqlx::query_as::<_, Problem>(
        r#"
        SELECT
          id, slug, title, description, starter_code, expected_stdout,
          fixed_top, fixed_bottom,
          editable_start_marker, editable_end_marker,
          created_at
        FROM problems
        WHERE id = ?
        "#,
    )
    .bind(req.problem_id)
    .fetch_one(&state.pool)
    .await;

    let problem = match p {
        Ok(p) => p,
        Err(sqlx::Error::RowNotFound) => {
            return HttpResponse::BadRequest().body("invalid problem_id");
        }
        Err(e) => {
            return HttpResponse::InternalServerError().body(format!("db error: {e}"));
        }
    };

    let (compiled, timed_out, stdout, stderr) = match run_user_code(&req.code).await {
        Ok(t) => t,
        Err(e) => return HttpResponse::InternalServerError().body(format!("runner error: {e}")),
    };

    let passed = if compiled && !timed_out {
        stdout.trim_end() == problem.expected_stdout.trim_end()
    } else {
        false
    };

    // 画面表示用の最終メッセージ
    let output = if compiled && !timed_out {
        if stderr.is_empty() { stdout.clone() } else { format!("{}{}", stdout, stderr) }
    } else if timed_out {
        "Time limit exceeded".to_string()
    } else {
        stderr.clone()
    };

    // 最小構成の submissions に保存
    save_submission(&state.pool, problem.id, &req.code, &output).await;

    HttpResponse::Ok().json(RunResp { compiled, timed_out, stdout, stderr, passed, output })
}

/* ==================== 起動 ==================== */

#[actix_web::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    // DB_PATH を使って“ファイル名指定”で接続
    let db_path = std::env::var("DB_PATH").unwrap_or_else(|_| "/app/data/data.db".into());
    if !Path::new(&db_path).exists() {
        anyhow::bail!("DB not found at {db_path}. Please pre-create it.");
    }

    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);

    let pool = SqlitePool::connect_with(opts).await?;

    // 外部キー ON（安全策）
    let _ = sqlx::query("PRAGMA foreign_keys = ON;").execute(&pool).await;

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(AppState { pool: pool.clone() }))
            .wrap(Logger::default())
            .wrap(DefaultHeaders::new().add(("Content-Security-Policy", CSP)))
            .service(web::resource("/favicon.ico").to(|| async { HttpResponse::NoContent().finish() }))
            .service(list_problems)
            .service(get_problem)
            .service(run)
            .service(Files::new("/", "/app/ui").index_file("index.html"))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await?;

    Ok(())
}
