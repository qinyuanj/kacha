//! Windows 服务模式（#70）：`kacha-server service <与前台相同的参数>` 由服务控制管理器（SCM）启动。
//!
//! 启动时及时报告 START_PENDING → RUNNING；收到 STOP 或 SHUTDOWN 后走与前台 Ctrl+C 相同的优雅关停，
//! 排空期间持续报告 STOP_PENDING（递增 checkpoint，带 wait hint），最后报告 STOPPED。
//! 启动失败时以非零服务退出码报告 STOPPED，让已配置的失败恢复策略（`sc.exe failureflag 1`）生效。
//! 服务名取自 SCM 传给 service_main 的第一个参数，不在程序里写死。

use std::ffi::OsString;
use std::sync::atomic::{AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Notify;
use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle};
use windows_service::{define_windows_service, service_dispatcher};

use crate::launch::{self, Mode, Options};
use crate::serve::DRAIN_LIMIT;
use crate::server_log::ServerLog;

static OPTIONS: OnceLock<Options> = OnceLock::new();
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

/// 排空期间上报 STOP_PENDING 的间隔与每次给 SCM 的 wait hint。
const STOP_PENDING_TICK: Duration = Duration::from_secs(3);
const STOP_PENDING_HINT: Duration = Duration::from_secs(10);
const START_PENDING_HINT: Duration = Duration::from_secs(30);

define_windows_service!(ffi_service_main, service_main);

/// 把进程交给 SCM 分发器，返回进程退出码。不是由 SCM 启动时（例如在终端直接运行）分发器会失败。
pub fn run(args: &[String]) -> i32 {
    let _ = OPTIONS.set(Options::parse(args));
    // 独立进程服务（SERVICE_WIN32_OWN_PROCESS）的分发表名称会被 SCM 忽略，真实服务名在 service_main 参数里。
    match service_dispatcher::start("", ffi_service_main) {
        Ok(()) => EXIT_CODE.load(Ordering::SeqCst),
        Err(e) => {
            eprintln!("无法连接 Windows 服务控制管理器：{e}");
            eprintln!("service 子命令只供 Windows 服务启动（sc.exe create ... binPath= \"kacha-server.exe service ...\"）；在终端前台运行请去掉 service。");
            launch::EXIT_FAILED
        }
    }
}

fn service_main(arguments: Vec<OsString>) {
    let name = arguments.first().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let options = OPTIONS.get().cloned().unwrap_or_else(|| Options::parse(&[]));
    let log = ServerLog::new(options.data_root.clone());
    if let Err(e) = serve_as(&name, options) {
        let _ = log.log(&format!("服务控制处理器注册失败（服务名 {name}）：{e}"));
        EXIT_CODE.store(launch::EXIT_FAILED, Ordering::SeqCst);
    }
}

fn serve_as(name: &str, options: Options) -> windows_service::Result<()> {
    let stop = Arc::new(Notify::new());
    let on_stop = stop.clone();
    let handle = service_control_handler::register(name, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            on_stop.notify_one();
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;
    let status = Reporter { handle, checkpoint: Arc::new(AtomicU32::new(0)) };
    status.pending(ServiceState::StartPending, START_PENDING_HINT);

    let log = ServerLog::new(options.data_root.clone());
    let ticker = status.clone();
    let started = launch::start(options, Mode::Service, DRAIN_LIMIT, |_| status.running(), async move {
        stop.notified().await;
        // 排空可能持续到上限：期间不断递增 checkpoint，避免被 SCM 判定为无响应。
        tokio::spawn(async move {
            loop {
                ticker.pending(ServiceState::StopPending, STOP_PENDING_HINT);
                tokio::time::sleep(STOP_PENDING_TICK).await;
            }
        });
    });
    let code = launch::run_blocking(started).unwrap_or_else(|e| {
        let _ = log.log(&format!("启动失败：无法创建异步运行时：{e}"));
        launch::EXIT_FAILED
    });
    status.stopped(code);
    EXIT_CODE.store(code, Ordering::SeqCst);
    Ok(())
}

#[derive(Clone)]
struct Reporter {
    handle: ServiceStatusHandle,
    checkpoint: Arc<AtomicU32>,
}

impl Reporter {
    fn set(&self, current_state: ServiceState, controls_accepted: ServiceControlAccept, exit_code: ServiceExitCode, checkpoint: u32, wait_hint: Duration) {
        let _ = self.handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state,
            controls_accepted,
            exit_code,
            checkpoint,
            wait_hint,
            process_id: None,
        });
    }

    fn pending(&self, state: ServiceState, wait_hint: Duration) {
        let checkpoint = self.checkpoint.fetch_add(1, Ordering::SeqCst) + 1;
        self.set(state, ServiceControlAccept::empty(), ServiceExitCode::Win32(0), checkpoint, wait_hint);
    }

    fn running(&self) {
        self.checkpoint.store(0, Ordering::SeqCst);
        self.set(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN, ServiceExitCode::Win32(0), 0, Duration::ZERO);
    }

    fn stopped(&self, code: i32) {
        let exit_code = if code == launch::EXIT_OK { ServiceExitCode::Win32(0) } else { ServiceExitCode::ServiceSpecific(code as u32) };
        self.set(ServiceState::Stopped, ServiceControlAccept::empty(), exit_code, 0, Duration::ZERO);
    }
}
