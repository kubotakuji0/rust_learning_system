use actix_files::Files;
use actix_web::{middleware::Logger, get, post, web, App, HttpResponse, HttpServer, Responder};
use serde::{Deserialize, Serialize};
use tokio::{process::Command, time::{timeout, Duration}};
use sqlx::{SqlitePool, Row};

#[derive(Deserialize)]
struct RunReq { problem_id: String, code: String }

#[derive(Serialize)]
struct RunResp {
    compiled: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
    uses_add_world: bool,
    output: String,     // stdout+stderr
    passed: bool,       // ★ 追加：合否（UIでは未使用でも将来のため返却）
}

#[derive(Serialize)]
struct ProblemDto {
    id: String,
    title: String,
    prompt_html: String,
    starter_code: String,
    expected_stdout: String,
    top_lock_lines: i64,
    bottom_anchor: String,
    language: String,
    checks: Vec<CheckDto>,
}
#[derive(Serialize)]
struct CheckDto { kind: String, pattern: String }

/// GET /api/problems/{id} : 問題取得（UIはこれで初期化）
#[get("/api/problems/{id}")]
async fn get_problem(path: web::Path<String>, pool: web::Data<SqlitePool>) -> impl Responder {
    let id = path.into_inner();
    let row = match sqlx::query("select id,title,prompt_html,starter_code,expected_stdout,top_lock_lines,bottom_anchor,language from problems where id=?1")
        .bind(&id).fetch_one(pool.get_ref()).await {
        Ok(r) => r,
        Err(_) => return HttpResponse::NotFound().body("problem not found")
    };
    let mut dto = ProblemDto {
        id: row.get(0), title: row.get(1), prompt_html: row.get(2),
        starter_code: row.get(3), expected_stdout: row.get(4),
        top_lock_lines: row.get::<i64,_>(5), bottom_anchor: row.get(6),
        language: row.get(7), checks: vec![],
    };
    let checks = sqlx::query("select kind, pattern from problem_checks where problem_id=?1")
        .bind(&dto.id).fetch_all(pool.get_ref()).await.unwrap_or_default();
    dto.checks = checks.into_iter()
        .map(|r| CheckDto { kind: r.get(0), pattern: r.get(1) })
        .collect();
    HttpResponse::Ok().json(dto)
}

/// 簡易：ルール評価（must_contain / must_not_contain）
fn evaluate_checks(code: &str, checks: &[(String,String)]) -> bool {
    for (kind, pat) in checks {
        match kind.as_str() {
            "must_contain"     => if !code.contains(pat) { return false; },
            "must_not_contain" => if  code.contains(pat) { return false; },
            _ => {}
        }
    }
    true
}

/// add_world の有無（互換用）
fn check_add_world_usage(src: &str) -> bool { src.contains("add_world(") }

#[post("/run")]
async fn run(req: web::Json<RunReq>, pool: web::Data<SqlitePool>) -> impl Responder {
    // 問題情報を取得（期待出力・チェック用）
    let prow = match sqlx::query("select expected_stdout from problems where id=?1")
        .bind(&req.problem_id).fetch_one(pool.get_ref()).await {
        Ok(r) => r,
        Err(_) => return HttpResponse::BadRequest().body("invalid problem_id")
    };
    let expected_stdout: String = prow.get(0);
    let checks = sqlx::query("select kind, pattern from problem_checks where problem_id=?1")
        .bind(&req.problem_id).fetch_all(pool.get_ref()).await
        .unwrap_or_default()
        .into_iter().map(|r| (r.get::<String,_>(0), r.get::<String,_>(1))).collect::<Vec<_>>();

    // 一時ファイルに保存
    let src = req.code.clone();
    let path_rs = "/tmp/main.rs";
    let bin_path = "/tmp/a.out";
    if let Err(e) = tokio::fs::write(path_rs, &src).await {
        let err = format!("write error: {e}");
        let uses = check_add_world_usage(&req.code);
        // 保存
        let _ = sqlx::query(r#"insert into submissions (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
          values (?1,?2,0,0,'',?3,0,?4,NULL)"#)
          .bind(&req.problem_id).bind(&req.code).bind(&err).bind(uses)
          .execute(pool.get_ref()).await;
        return HttpResponse::Ok().json(RunResp {
            compiled: false, timed_out: false,
            stdout: String::new(), stderr: err.clone(),
            uses_add_world: uses, output: err, passed: false,
        });
    }

    // コンパイル
    let compile_res = Command::new("rustc")
        .arg(path_rs).arg("-O").arg("-o").arg(bin_path)
        .kill_on_drop(true)
        .output().await;

    match compile_res {
        Ok(out) if out.status.success() => {
            // 実行（2秒）
            let start = std::time::Instant::now();
            let run_fut = Command::new(bin_path).kill_on_drop(true).output();
            let output = match timeout(Duration::from_secs(2), run_fut).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    let err = format!("exec error: {e}");
                    let uses = check_add_world_usage(&req.code);
                    let _ = sqlx::query(r#"insert into submissions (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
                      values (?1,?2,1,0,'',?3,0,?4,NULL)"#)
                      .bind(&req.problem_id).bind(&req.code).bind(&err).bind(uses)
                      .execute(pool.get_ref()).await;
                    return HttpResponse::Ok().json(RunResp {
                      compiled: true, timed_out: false,
                      stdout: String::new(), stderr: err.clone(),
                      uses_add_world: uses, output: err, passed: false,
                    });
                }
                Err(_) => {
                    let err = String::from("timed out (2s)");
                    let uses = check_add_world_usage(&req.code);
                    let _ = sqlx::query(r#"insert into submissions (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
                      values (?1,?2,1,1,'',?3,0,?4,NULL)"#)
                      .bind(&req.problem_id).bind(&req.code).bind(&err).bind(uses)
                      .execute(pool.get_ref()).await;
                    return HttpResponse::Ok().json(RunResp {
                      compiled: true, timed_out: true,
                      stdout: String::new(), stderr: err.clone(),
                      uses_add_world: uses, output: err, passed: false,
                    });
                }
            };

            let dur = start.elapsed().as_millis() as i64;
            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let combined = format!("{}{}", stdout, stderr);

            // 合否判定：期待出力一致 & ルールOK
            let passed = stdout.replace("\r\n","\n") == expected_stdout
                      && evaluate_checks(&req.code, &checks);

            let uses = check_add_world_usage(&req.code);
            // 保存
            let _ = sqlx::query(r#"insert into submissions
              (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
              values (?1,?2,1,0,?3,?4,?5,?6,?7)"#)
              .bind(&req.problem_id).bind(&req.code)
              .bind(&stdout).bind(&stderr)
              .bind(passed).bind(uses).bind(dur)
              .execute(pool.get_ref()).await;

            HttpResponse::Ok().json(RunResp {
                compiled: true, timed_out: false,
                stdout, stderr, uses_add_world: uses,
                output: combined, passed
            })
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).into_owned();
            let uses = check_add_world_usage(&req.code);
            let _ = sqlx::query(r#"insert into submissions
              (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
              values (?1,?2,0,0,'',?3,0,?4,NULL)"#)
              .bind(&req.problem_id).bind(&req.code)
              .bind(&err).bind(uses)
              .execute(pool.get_ref()).await;

            HttpResponse::Ok().json(RunResp {
                compiled: false, timed_out: false,
                stdout: String::new(), stderr: err.clone(),
                uses_add_world: uses, output: err, passed: false
            })
        }
        Err(e) => {
            let err = format!("spawn rustc failed: {e}");
            let uses = check_add_world_usage(&req.code);
            let _ = sqlx::query(r#"insert into submissions
              (problem_id,code,compiled,timed_out,stdout,stderr,passed,uses_add_world,duration_ms)
              values (?1,?2,0,0,'',?3,0,?4,NULL)"#)
              .bind(&req.problem_id).bind(&req.code)
              .bind(&err).bind(uses)
              .execute(pool.get_ref()).await;

            HttpResponse::Ok().json(RunResp {
                compiled: false, timed_out: false,
                stdout: String::new(), stderr: err.clone(),
                uses_add_world: uses, output: err, passed: false
            })
        }
    }
}

#[actix_web::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));

    // SQLite を作成・接続し、マイグレーションを流す
    let pool = SqlitePool::connect("sqlite://./data.db").await?;
    // 簡易マイグレーション適用（本格運用では sqlx::migrate! を使う）
    // ここでは migrations/*.sql を自前で流す代わりに、初回は手動で流してもOK

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(pool.clone()))
            .wrap(Logger::default())
            .service(get_problem)
            .service(run)
            .service(Files::new("/", "/app/ui").index_file("index.html"))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await?;
    Ok(())
}
