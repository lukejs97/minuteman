//! Desktop only: the menu bar (on Windows, notification area) icon and its
//! small window, the Contacts window and its own menu bar icon (and, on a
//! Mac, its "Minuteman Contacts" app), the quick-add and contacts keyboard
//! shortcuts, and staying open in the menu bar when the main window is closed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{
    App, AppHandle, Emitter, LogicalPosition, Manager, Monitor, PhysicalPosition, PhysicalSize, Rect, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The menu bar icon's ID.
const TRAY: &str = "minuteman";
/// Contacts' own menu bar icon's ID (Settings → Contacts icon).
const CONTACTS_TRAY: &str = "minuteman-contacts";
/// Passed to open just Contacts (the "Minuteman Contacts" shortcut and app):
/// at start, instead of the calendar; and to the copy already running.
pub const OPEN_CONTACTS: &str = "--contacts";
/// What's beside the icon now, to skip setting it again.
static MENU_BAR_TEXT: Mutex<Option<String>> = Mutex::new(None);

/// The menu bar window's label.
pub const FLYOUT: &str = "flyout";
/// Passed when Minuteman opens at login: start in the menu bar, the window closed.
pub const OPENED_AT_LOGIN: &str = "--hidden";
/// Opens New event from anywhere: ⌥⌘N on a Mac, Ctrl+Alt+N on Windows.
pub const QUICK_ADD_SHORTCUT: &str = "CommandOrControl+Alt+N";
/// The Contacts window's label.
pub const CONTACTS: &str = "contacts";
/// Opens Contacts from anywhere: ⌥⌘K on a Mac, Ctrl+Alt+K on Windows.
pub const CONTACTS_SHORTCUT: &str = "CommandOrControl+Alt+K";

/// When the small window last hid itself because you clicked elsewhere.
static HIDDEN_ON_BLUR: Mutex<Option<Instant>> = Mutex::new(None);
/// Where the menu bar icon is (from its last click or hover), to open the
/// small window under it.
static TRAY_RECT: Mutex<Option<Rect>> = Mutex::new(None);
/// Whether the small window has been detached: a window of its own that stays
/// where you put it, and stays open when you click elsewhere.
static DETACHED: AtomicBool = AtomicBool::new(false);
/// When the app last moved the small window itself, to tell that from you
/// dragging it.
static PLACED: Mutex<Option<Instant>> = Mutex::new(None);
/// Room between the menu bar and the window (points).
const GAP: f64 = 4.0;

pub fn setup(app: &mut App) -> tauri::Result<()> {
    create_flyout(app)?;
    create_tray(app)?;
    let prefs = crate::prefs::get();
    if prefs.contacts_menu_bar {
        create_contacts_tray(app.handle())?;
    }
    #[cfg(target_os = "macos")]
    sync_contacts_launcher(app.handle(), prefs.contacts_launcher);

    // The shortcut may already belong to another app; then it's just not available.
    let registered = app.global_shortcut().on_shortcut(QUICK_ADD_SHORTCUT, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            show_flyout(app, true);
        }
    });
    if let Err(e) = registered {
        eprintln!("Couldn't register {QUICK_ADD_SHORTCUT}: {e}");
    }
    let registered = app.global_shortcut().on_shortcut(CONTACTS_SHORTCUT, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            show_contacts(app, None);
        }
    });
    if let Err(e) = registered {
        eprintln!("Couldn't register {CONTACTS_SHORTCUT}: {e}");
    }

    // Closing the main window keeps the app (and its alerts) running in the
    // menu bar; Quit is in the icon's menu, or ⌘Q.
    let just_contacts = std::env::args().any(|arg| arg == OPEN_CONTACTS);
    if let Some(main) = app.get_webview_window("main") {
        // Opened at login, or as "Minuteman Contacts": the calendar stays closed.
        if just_contacts || std::env::args().any(|arg| arg == OPENED_AT_LOGIN) {
            let _ = main.hide();
        }
        let window = main.clone();
        main.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }
    if just_contacts {
        show_contacts(app.handle(), None);
    }
    Ok(())
}

/// Opened again while running (see the single-instance plugin in lib.rs):
/// Contacts if that's what was opened ("Minuteman Contacts"), else the calendar.
pub fn opened_again(app: &AppHandle, args: &[String]) {
    if args.iter().any(|arg| arg == OPEN_CONTACTS) {
        show_contacts(app, None);
    } else {
        show_main(app);
    }
}

/// Contacts' own menu bar icon: click for Contacts; right-click for New
/// contact, the calendar, and Quit.
fn create_contacts_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "contacts-tray-open", "Open Contacts", true, Some(CONTACTS_SHORTCUT))?;
    let new = MenuItem::with_id(app, "contacts-tray-new", "New Contact…", true, None::<&str>)?;
    let calendar = MenuItem::with_id(app, "contacts-tray-calendar", "Open Minuteman", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "contacts-tray-quit", "Quit Minuteman", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new, &calendar, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/contacts-tray.png"))?;
    TrayIconBuilder::with_id(CONTACTS_TRAY)
        .icon(icon)
        // In the app's colours, as the calendar's (icons/source/contacts-icon.py).
        .icon_as_template(false)
        .tooltip("Minuteman Contacts")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "contacts-tray-open" => show_contacts(app, None),
            "contacts-tray-new" => show_new_contact(app),
            "contacts-tray-calendar" => show_main(app),
            "contacts-tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_contacts(tray.app_handle(), None);
            }
        })
        .build(app)?;
    Ok(())
}

/// Settings → Contacts icon: adds or takes away Contacts' menu bar icon.
pub fn set_contacts_tray(app: &AppHandle, on: bool) {
    let handle = app.clone();
    // Menu bar icons are made and removed on the main thread.
    let _ = app.run_on_main_thread(move || {
        let there = handle.tray_by_id(CONTACTS_TRAY).is_some();
        if on && !there {
            if let Err(e) = create_contacts_tray(&handle) {
                eprintln!("Couldn't add the Contacts icon: {e}");
            }
        } else if !on && there {
            let _ = handle.remove_tray_by_id(CONTACTS_TRAY);
        }
    });
}

/// Mac: "Minuteman Contacts" in ~/Applications (Launchpad, Spotlight, the
/// Dock if you put it there), a little app that opens Contacts: in the
/// Minuteman that's running (it passes `--contacts` to it, as the Windows
/// Start menu shortcut does), or by starting Minuteman with just Contacts.
/// Written when Minuteman starts (so it follows where Minuteman is), and
/// removed when switched off in Settings. Not for a development build.
#[cfg(target_os = "macos")]
pub fn sync_contacts_launcher(app: &AppHandle, on: bool) {
    let Some(home) = std::env::var_os("HOME") else { return };
    let launcher = std::path::Path::new(&home).join("Applications").join("Minuteman Contacts.app");
    if !on {
        // Only one this made (its own identifier), never something else by that name.
        let ours = std::fs::read_to_string(launcher.join("Contents/Info.plist"))
            .is_ok_and(|plist| plist.contains(LAUNCHER_ID));
        if ours {
            let _ = std::fs::remove_dir_all(&launcher);
        }
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    // …/Minuteman.app/Contents/MacOS/Minuteman: only an installed app.
    let Some(bundle) = exe.ancestors().nth(3).filter(|p| p.extension().is_some_and(|e| e == "app")) else { return };
    let Some(name) = exe.file_name().and_then(|n| n.to_str()) else { return };
    let script = launcher_script(&exe.to_string_lossy(), name, &bundle.to_string_lossy());
    let plist = launcher_plist(app.package_info().version.to_string().as_str());
    let contents = launcher.join("Contents");
    let current = std::fs::read_to_string(contents.join("MacOS/launcher")).ok();
    if current.as_deref() == Some(script.as_str()) && contents.join("Resources/contacts.icns").exists() {
        return;
    }
    let written = (|| -> std::io::Result<()> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(contents.join("MacOS"))?;
        std::fs::create_dir_all(contents.join("Resources"))?;
        std::fs::write(contents.join("Info.plist"), plist)?;
        let path = contents.join("MacOS/launcher");
        std::fs::write(&path, script)?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
        if let Ok(icon) = app.path().resource_dir().map(|dir| dir.join("contacts.icns")) {
            std::fs::copy(icon, contents.join("Resources/contacts.icns"))?;
        }
        Ok(())
    })();
    if let Err(e) = written {
        eprintln!("Couldn't write Minuteman Contacts.app: {e}");
    }
}

/// The launcher's bundle identifier: how it's known to be this app's to replace or remove.
#[cfg(any(target_os = "macos", test))]
const LAUNCHER_ID: &str = "com.lukesassa.calendar.contacts-launcher";

/// The launcher's script: with Minuteman running, hand it `--contacts` (the
/// single-instance plugin passes it on and this copy stops); otherwise start
/// Minuteman with just Contacts.
#[cfg(any(target_os = "macos", test))]
fn launcher_script(exe: &str, name: &str, bundle: &str) -> String {
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    format!(
        "#!/bin/sh\n# Minuteman Contacts: opens Contacts in Minuteman (written by Minuteman; see desktop.rs).\n\
         if /usr/bin/pgrep -x {name} >/dev/null 2>&1; then\n  exec {exe} {OPEN_CONTACTS}\nelse\n  exec /usr/bin/open -a {bundle} --args {OPEN_CONTACTS}\nfi\n",
        name = quote(name),
        exe = quote(exe),
        bundle = quote(bundle),
    )
}

#[cfg(any(target_os = "macos", test))]
fn launcher_plist(version: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIdentifier</key><string>{LAUNCHER_ID}</string>
  <key>CFBundleName</key><string>Minuteman Contacts</string>
  <key>CFBundleDisplayName</key><string>Minuteman Contacts</string>
  <key>CFBundleIconFile</key><string>contacts</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
"#
    )
}

/// The small window under the menu bar icon: the next few days, and quick add.
/// It loads the same page, which shows the compact layout when it sees
/// `window.__MINUTEMAN_FLYOUT__`.
fn create_flyout(app: &App) -> tauri::Result<()> {
    let flyout = WebviewWindowBuilder::new(app, FLYOUT, WebviewUrl::App("index.html".into()))
        .title("Minuteman")
        .inner_size(380.0, 600.0)
        .min_inner_size(320.0, 360.0)
        .resizable(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .initialization_script("window.__MINUTEMAN_FLYOUT__ = true;")
        .build()?;
    let window = flyout.clone();
    flyout.on_window_event(move |event| match event {
        // Like a menu: it goes away when you click elsewhere (unless detached).
        WindowEvent::Focused(false) if !DETACHED.load(Ordering::Relaxed) && window.is_visible().unwrap_or(false) => {
            let _ = window.hide();
            *HIDDEN_ON_BLUR.lock().expect("not poisoned") = Some(Instant::now());
        }
        // Dragged somewhere: detached, like a popover pulled off its icon.
        WindowEvent::Moved(_) if !DETACHED.load(Ordering::Relaxed) && window.is_visible().unwrap_or(false) => {
            let placed = *PLACED.lock().expect("not poisoned");
            if !placed.is_some_and(|at| at.elapsed() < Duration::from_millis(500)) {
                set_flyout_detached(window.app_handle(), true);
                let _ = window.emit("flyout-detached", ());
            }
        }
        _ => {}
    });
    Ok(())
}

fn create_tray(app: &App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Minuteman", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "New Event…", true, Some(QUICK_ADD_SHORTCUT))?;
    let contacts = MenuItem::with_id(app, "contacts", "Contacts", true, Some(CONTACTS_SHORTCUT))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Minuteman", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &new, &contacts, &quit])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id(TRAY)
        .icon(icon)
        // The app's own logo, in its colours (icons/source/tray.svg).
        .icon_as_template(false)
        .tooltip("Minuteman")
        .menu(&menu)
        // Left click: the small window; right click: the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "new" => show_flyout(app, true),
            "contacts" => show_contacts(app, None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Remembers where the icon is, to place the window under it.
            if let TrayIconEvent::Click { rect, .. }
            | TrayIconEvent::Enter { rect, .. }
            | TrayIconEvent::Move { rect, .. } = &event
            {
                *TRAY_RECT.lock().expect("not poisoned") = Some(*rect);
            }
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_flyout(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn toggle_flyout(app: &AppHandle) {
    // Clicking the icon while the window is open first takes focus from it,
    // which hides it; that click should leave it closed, not reopen it.
    let hidden_at = *HIDDEN_ON_BLUR.lock().expect("not poisoned");
    if hidden_at.is_some_and(|at| at.elapsed() < Duration::from_millis(300)) {
        return;
    }
    match app.get_webview_window(FLYOUT) {
        Some(flyout) if flyout.is_visible().unwrap_or(false) => {
            let _ = flyout.hide();
        }
        _ => show_flyout(app, false),
    }
}

/// Shows the small window under the menu bar icon (or where you left it, if
/// detached); `new_event` also opens New event in it.
pub fn show_flyout(app: &AppHandle, new_event: bool) {
    let Some(flyout) = app.get_webview_window(FLYOUT) else { return };
    if !DETACHED.load(Ordering::Relaxed) {
        place_under_icon(app, &flyout);
    }
    let _ = flyout.show();
    let _ = flyout.set_focus();
    let _ = flyout.emit(if new_event { "flyout-new" } else { "flyout-shown" }, ());
}

/// Detaches the small window (it stays put, and open, until you close it),
/// or puts it back under the menu bar icon.
pub fn set_flyout_detached(app: &AppHandle, detached: bool) {
    DETACHED.store(detached, Ordering::Relaxed);
    let Some(flyout) = app.get_webview_window(FLYOUT) else { return };
    // Detached, it's an ordinary window, which others can go in front of.
    let _ = flyout.set_always_on_top(!detached);
    if !detached {
        place_under_icon(app, &flyout);
    }
}

/// Moves the window just under the menu bar icon (on Windows, just above the
/// notification area icon), on the screen the icon is on.
///
/// Windows are placed in points on a Mac (the same on every screen) and in
/// pixels on Windows. The icon's place comes in its screen's pixels, and on a
/// Mac with screens of different scales that alone doesn't say which screen
/// (a pixel spot on one can be a pixel spot on another), so on a Mac the
/// screen is the one the pointer is on: when you click the icon, the icon's.
fn place_under_icon(app: &AppHandle, flyout: &WebviewWindow) {
    let mac = cfg!(target_os = "macos");
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    // Pixels per unit of placement on screen `m`.
    let unit = |m: &Monitor| if mac { m.scale_factor() } else { 1.0 };
    let tray = *TRAY_RECT.lock().expect("not poisoned");
    let icon_pixels = tray.map(|rect| (rect.position.to_physical::<f64>(1.0), rect.size.to_physical::<f64>(1.0)));

    let screen = if mac {
        // The pointer comes in the main screen's pixels.
        let pointer = app.cursor_position().ok().zip(primary.as_ref()).map(|(at, main)| {
            PhysicalPosition::new(at.x / main.scale_factor(), at.y / main.scale_factor())
        });
        pointer.and_then(|at| monitors.iter().find(|m| contains(m, unit(m), at)))
    } else {
        icon_pixels.and_then(|(at, _)| monitors.iter().find(|m| contains(m, 1.0, at)))
    };
    let Some(screen) = screen.cloned().or(primary) else { return };
    let unit = unit(&screen);

    let Ok(size) = flyout.outer_size() else { return };
    let size = size.to_logical::<f64>(flyout.scale_factor().unwrap_or(1.0));
    // The window's size in this screen's units.
    let (width, height) = if mac {
        (size.width, size.height)
    } else {
        (size.width * screen.scale_factor(), size.height * screen.scale_factor())
    };
    let area = screen.work_area();
    let (left, top) = (area.position.x as f64 / unit, area.position.y as f64 / unit);
    let (right, bottom) = (left + area.size.width as f64 / unit, top + area.size.height as f64 / unit);
    let gap = GAP * screen.scale_factor() / unit;

    // The icon, if it's on this screen.
    let icon = icon_pixels
        .map(|(at, size)| (at.x / unit, at.y / unit, size.width / unit, size.height / unit))
        .filter(|&(x, y, ..)| contains(&screen, unit, PhysicalPosition::new(x, y)));
    let (x, y) = match icon {
        Some((x, y, icon_width, icon_height)) => {
            let x = x + icon_width / 2.0 - width / 2.0;
            // Under the icon if it's at the top of the screen, else above it.
            let y = if y < (top + bottom) / 2.0 { y + icon_height + gap } else { y - height - gap };
            (x, y)
        }
        // Not clicked or hovered yet, or on another screen: the top right corner.
        None => (right - width - gap, top + gap),
    };
    let x = x.min(right - width - gap).max(left + gap);
    let y = y.min(bottom - height).max(top);
    *PLACED.lock().expect("not poisoned") = Some(Instant::now());
    if mac {
        let _ = flyout.set_position(LogicalPosition::new(x, y));
    } else {
        let _ = flyout.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

/// Whether `at` (in pixels over `unit`) is on screen `monitor`.
fn contains(monitor: &Monitor, unit: f64, at: PhysicalPosition<f64>) -> bool {
    let (origin, size): (&PhysicalPosition<i32>, &PhysicalSize<u32>) = (monitor.position(), monitor.size());
    let (x, y) = (origin.x as f64 / unit, origin.y as f64 / unit);
    let (width, height) = (size.width as f64 / unit, size.height as f64 / unit);
    at.x >= x && at.x < x + width && at.y >= y && at.y < y + height
}

/// One Contacts window at a time. The button and the shortcut can both fire
/// before the first one exists.
static CONTACTS_CREATE: Mutex<()> = Mutex::new(());

/// Opens the Contacts window (made the first time), in front, with `query`
/// in its box if given (e.g. a guest's email address to look up).
pub fn show_contacts(app: &AppHandle, query: Option<&str>) {
    open_contacts(app, query, false);
}

/// Opens Contacts with its New contact form (Contacts' menu bar icon).
pub fn show_new_contact(app: &AppHandle) {
    open_contacts(app, None, true);
}

fn open_contacts(app: &AppHandle, query: Option<&str>, new_contact: bool) {
    // From the menu bar window (a guest's name): it goes, like a menu, unless detached.
    if let Some(flyout) = app.get_webview_window(FLYOUT)
        && !DETACHED.load(Ordering::Relaxed)
    {
        let _ = flyout.hide();
    }
    if let Some(window) = app.get_webview_window(CONTACTS) {
        reveal_contacts(&window, query, new_contact);
        return;
    }
    // Windows: `WebviewWindowBuilder::build` deadlocks on the UI thread when
    // it's called from a synchronous command or a menu/shortcut handler. The
    // WebView2 callback needs that same thread, so the window stays blank and
    // its close button never runs. Build it on a worker thread instead.
    // Elsewhere, build here: a Mac window is created on the main thread.
    #[cfg(windows)]
    {
        let app = app.clone();
        let query = query.map(str::to_owned);
        std::thread::spawn(move || open_contacts_window(&app, query.as_deref(), new_contact));
    }
    #[cfg(not(windows))]
    open_contacts_window(app, query, new_contact);
}

/// Builds the Contacts window if it isn't there yet, then shows it.
fn open_contacts_window(app: &AppHandle, query: Option<&str>, new_contact: bool) {
    let _creating = CONTACTS_CREATE.lock().expect("not poisoned");
    if let Some(window) = app.get_webview_window(CONTACTS) {
        reveal_contacts(&window, query, new_contact);
        return;
    }
    // The query as a JSON string is a safe JavaScript literal.
    let query_json = serde_json::to_string(&query).expect("serializable");
    // Set once the page has actually loaded, not while it's still `about:blank`.
    let loaded = Arc::new(AtomicBool::new(false));
    let loaded_for_page = Arc::clone(&loaded);
    let built = WebviewWindowBuilder::new(app, CONTACTS, WebviewUrl::App("contacts.html".into()))
        .title("Minuteman Contacts")
        .inner_size(860.0, 620.0)
        .min_inner_size(340.0, 420.0)
        .initialization_script(format!(
            "window.__MINUTEMAN_CONTACTS_QUERY__ = {query_json}; window.__MINUTEMAN_CONTACTS_NEW__ = {new_contact};"
        ))
        .on_page_load(move |_window, payload| {
            // `about:blank` is the empty window WebView2 shows before (or
            // instead of) the page. Anything else means the page arrived.
            let url = payload.url().as_str();
            if payload.event() == PageLoadEvent::Finished && !url.starts_with("about:") {
                loaded_for_page.store(true, Ordering::Relaxed);
            }
        })
        .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            eprintln!("Couldn't open Contacts: {e}");
            return;
        }
    };
    keep_contacts_closable(&window, loaded);
    // The query is already in the page's startup script. Showing is enough;
    // nothing is listening for `contacts-shown` yet.
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Shows `window` and, when it's already open, puts `query` in its box (and
/// with `new_contact`, opens New contact).
fn reveal_contacts(window: &WebviewWindow, query: Option<&str>, new_contact: bool) {
    let _ = window.emit("contacts-shown", query);
    if new_contact {
        let _ = window.emit("contacts-new", ());
    }
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Closing Contacts hides it, so the next open is immediate. Until the page
/// has loaded — or if hiding fails — the window really closes, so a blank
/// one can't get stuck on screen.
fn keep_contacts_closable(window: &WebviewWindow, loaded: Arc<AtomicBool>) {
    let hide = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if !loaded.load(Ordering::Relaxed) {
                return;
            }
            api.prevent_close();
            // Hiding from inside this handler does nothing on Windows until
            // the handler has returned. Ask the event loop to hide it next,
            // and destroy the window if that fails.
            let to_hide = hide.clone();
            let queued = hide.run_on_main_thread(move || {
                if to_hide.hide().is_err() {
                    let _ = to_hide.destroy();
                }
            });
            if queued.is_err() && hide.hide().is_err() {
                let _ = hide.destroy();
            }
        }
    });
}

pub fn show_main(app: &AppHandle) {
    if let Some(flyout) = app.get_webview_window(FLYOUT) {
        let _ = flyout.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// Puts `text` (the next event) beside the menu bar icon, or nothing. On
/// Windows, where icons have no text, it's the icon's tooltip instead.
pub fn set_menu_bar_text(app: &AppHandle, text: Option<String>) {
    let mut shown = MENU_BAR_TEXT.lock().expect("not poisoned");
    if *shown == text {
        return;
    }
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    if cfg!(target_os = "macos") {
        let _ = tray.set_title(text.as_deref());
    } else {
        let _ = tray.set_tooltip(Some(text.as_deref().unwrap_or("Minuteman")));
    }
    *shown = text;
}

#[cfg(test)]
mod launcher_tests {
    use super::*;

    #[test]
    fn the_contacts_launcher_hands_over_or_starts_minuteman() {
        let script = launcher_script(
            "/Applications/Minuteman.app/Contents/MacOS/Minuteman",
            "Minuteman",
            "/Applications/Minuteman.app",
        );
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("if /usr/bin/pgrep -x 'Minuteman' >/dev/null 2>&1; then\n"));
        assert!(script.contains("  exec '/Applications/Minuteman.app/Contents/MacOS/Minuteman' --contacts\n"));
        assert!(script.contains("  exec /usr/bin/open -a '/Applications/Minuteman.app' --args --contacts\n"));
        // A path with a quote in it stays one argument.
        let odd = launcher_script("/Users/o'neil/Minuteman.app/Contents/MacOS/Minuteman", "Minuteman", "/Users/o'neil/Minuteman.app");
        assert!(odd.contains("'/Users/o'\\''neil/Minuteman.app/Contents/MacOS/Minuteman'"), "{odd}");
        let plist = launcher_plist("1.2.3");
        assert!(plist.contains(LAUNCHER_ID) && plist.contains("<key>LSUIElement</key><true/>") && plist.contains(">1.2.3<"));
    }
}
