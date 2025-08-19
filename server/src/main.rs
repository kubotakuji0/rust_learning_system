use actix_files::Files;
use actix_web::{middleware::Logger, post, web, App, HttpResponse, HttpServer, Responder};
use serde::{Deserialize, Serialize};
use tokio::{process::Command, time::{timeout, Duration}};

#[derive(Deserialize)]
struct RunReq { code: String }

#[derive(Serialize)]
struct RunResp {
    compiled: bool,
    timed_out: bool,
    stdout: String,
    stderr: String,
    used_add_world: bool,
    output: String, // ★ stdout+stderr を結合したもの
}

#[post("/run")]
async fn run(req: web::Json<RunReq>) -> impl Responder {
    let src = format!("{}", req.code);
    let path_rs = "/tmp/main.rs";
    let bin_path = "/tmp/a.out";

    if let Err(e) = tokio::fs::write(path_rs, src).await {
        let err = format!("write error: {e}");
        return HttpResponse::Ok().json(RunResp {
            compiled: false,
            timed_out: false,
            stdout: String::new(),
            stderr: err.clone(),
            used_add_world: req.code.contains("add_world("),
            output: err,
        });
    }

    // Compile
    let compile_res = Command::new("rustc")
        .arg(path_rs)
        .arg("-O")
        .arg("-o").arg(bin_path)
        .kill_on_drop(true)
        .output()
        .await;

    match compile_res {
        Ok(out) if out.status.success() => {
            // Run with timeout
            let run_fut = Command::new(bin_path)
                .kill_on_drop(true)
                .output();

            let output = match timeout(Duration::from_secs(2), run_fut).await {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    let err = format!("exec error: {e}");
                    return HttpResponse::Ok().json(RunResp {
                        compiled: true,
                        timed_out: false,
                        stdout: String::new(),
                        stderr: err.clone(),
                        used_add_world: req.code.contains("add_world("),
                        output: err,
                    });
                }
                Err(_) => {
                    let err = String::from("timed out (2s)");
                    return HttpResponse::Ok().json(RunResp {
                        compiled: true,
                        timed_out: true,
                        stdout: String::new(),
                        stderr: err.clone(),
                        used_add_world: req.code.contains("add_world("),
                        output: err,
                    });
                }
            };

            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let combined = format!("{}{}", stdout, stderr);

            HttpResponse::Ok().json(RunResp {
                compiled: true,
                timed_out: false,
                stdout,
                stderr,
                used_add_world: req.code.contains("add_world("),
                output: combined,
            })
        }
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr).into_owned();
            HttpResponse::Ok().json(RunResp {
                compiled: false,
                timed_out: false,
                stdout: String::new(),
                stderr: err.clone(),
                used_add_world: req.code.contains("add_world("),
                output: err,
            })
        }
        Err(e) => {
            let err = format!("spawn rustc failed: {e}");
            HttpResponse::Ok().json(RunResp {
                compiled: false,
                timed_out: false,
                stdout: String::new(),
                stderr: err.clone(),
                used_add_world: req.code.contains("add_world("),
                output: err,
            })
        }
    }
}

#[actix_web::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init_from_env(env_logger::Env::default().default_filter_or("info"));
    HttpServer::new(|| {
        App::new()
            .wrap(Logger::default())
            .service(run)
            .service(Files::new("/", "/app/ui").index_file("index.html"))
    })
    .bind(("0.0.0.0", 8080))?
    .run()
    .await?;
    Ok(())
}