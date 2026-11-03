//! Windows: where the PC is (Windows' location service), for drives that
//! start from there (Settings → Leave from → Start from where I am), as
//! travel.rs does with Core Location on a Mac. Needs Windows Settings →
//! Privacy & security → Location, with "Let desktop apps access your
//! location" on; otherwise `None`, and alerts use the address in Settings.

use windows::Devices::Geolocation::{GeolocationAccessStatus, Geolocator, PositionAccuracy};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};

/// Latitude and longitude, or `None` if location is off or not found.
pub async fn current_location() -> Option<(f64, f64)> {
    tauri::async_runtime::spawn_blocking(|| {
        // This thread's own apartment for the Windows Runtime ("already
        // initialized" is fine).
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        locate().ok().flatten()
    })
    .await
    .ok()
    .flatten()
}

fn locate() -> windows::core::Result<Option<(f64, f64)>> {
    if Geolocator::RequestAccessAsync()?.join()? != GeolocationAccessStatus::Allowed {
        return Ok(None);
    }
    let locator = Geolocator::new()?;
    // About 100 m is plenty (and doesn't wait for GPS).
    locator.SetDesiredAccuracy(PositionAccuracy::Default)?;
    let position = locator.GetGeopositionAsync()?.join()?;
    let point = position.Coordinate()?.Point()?.Position()?;
    Ok(Some((point.Latitude, point.Longitude)))
}
