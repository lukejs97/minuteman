/// <reference types="vite/client" />

interface Window {
  /** Set in the menu bar window (see src-tauri/src/desktop.rs). */
  __MINUTEMAN_FLYOUT__?: boolean;
  /** Set in the Contacts window: what to show first, e.g. a guest's address (see desktop.rs). */
  __MINUTEMAN_CONTACTS_QUERY__?: string | null;
  /** Opened from Contacts' menu bar icon's New Contact…: open the New contact form. */
  __MINUTEMAN_CONTACTS_NEW__?: boolean;
}
