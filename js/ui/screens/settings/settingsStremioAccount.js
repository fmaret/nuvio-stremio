import { StremioAccount } from "../../../data/repository/stremioAccount.js";
import { addonRepository } from "../../../data/repository/addonRepository.js";
import { ProfileManager } from "../../../core/profile/profileManager.js";
import { TraktSettingsStore, WatchProgressSource } from "../../../data/local/traktSettingsStore.js";
import { QrCodeGenerator, t, escapeHtml, escapeAttribute } from "./settingsScreenContext.js";

const POLL_INTERVAL_MS = 3000;
const LINK_LIFETIME_MS = 5 * 60 * 1000;

export function stopStremioAuthorization() {
  this.stremioAuthNonce = (this.stremioAuthNonce || 0) + 1;
  clearTimeout(this.stremioAuthTimer);
  this.stremioAuthTimer = null;
}

export function openStremioAuthorization() {
  stopStremioAuthorization.call(this);
  const nonce = this.stremioAuthNonce;
  const profileId = String(ProfileManager.getActiveProfileId());
  const current = () =>
    this.isMounted &&
    this.stremioAuthNonce === nonce &&
    String(ProfileManager.getActiveProfileId()) === profileId;
  let session = null;
  const show = (message, html = "") => {
    if (!current()) return;
    this.openOptionDialog({
      title: "Stremio",
      message: html ? "" : message,
      messageHtml: html
        ? `<p class="settings-debrid-auth-copy">${escapeHtml(message)}</p>${html}`
        : "",
      options: [{ id: "cancel", label: t("common.cancel") }],
      returnFocusKey: "integration:stremio:account",
      onClose: () => stopStremioAuthorization.call(this),
      onSelect: () => true,
      onRender: (slot) => {
        const canvas = slot.querySelector("[data-stremio-qr]");
        if (canvas && session) {
          try {
            QrCodeGenerator.generate(canvas, session.url, 420);
          } catch (_) {
            canvas.remove();
          } // The address and code remain usable.
        }
      }
    });
  };
  const fail = async (error) => {
    if (!current()) return;
    show(String(error?.message || t("stremio_unavailable", {}, "Unable to reach Stremio. Try again.")));
    await this.render({ refreshModel: false });
  };
  show(t("common.loading"));
  void (async () => {
    try {
      session = await StremioAccount.startLink();
      if (!current()) return;
      const expiresAt = Date.now() + LINK_LIFETIME_MS;
      show(
        t(
          "stremio_awaiting_instruction",
          {},
          "Scan the code or open the address on your phone or computer, then log in to Stremio."
        ),
        `<div class="settings-debrid-auth-body"><canvas class="settings-debrid-auth-qr" data-stremio-qr aria-label="${escapeAttribute(session.url)}"></canvas><div class="settings-debrid-auth-code">${escapeHtml(session.code)}</div><div class="settings-debrid-auth-url">${escapeHtml(session.url)}</div></div>`
      );
      await this.render({ refreshModel: false });
      const poll = async () => {
        try {
          if (!current()) return;
          if (Date.now() > expiresAt) {
            await fail(new Error(t("stremio_code_expired", {}, "The code expired. Try again.")));
            return;
          }
          const authorized = await StremioAccount.pollLink(session.code, profileId);
          if (!current()) return;
          if (authorized) {
            // First connection: bring the account's addons and select Stremio for Continue Watching.
            TraktSettingsStore.setWatchProgressSource(WatchProgressSource.STREMIO);
            const added = await StremioAccount.importAddons(addonRepository).catch(() => 0);
            this.stremioAccountMessage = t(
              "stremio_connected",
              [added],
              `Connected to Stremio. ${added} addon(s) imported.`
            );
            this.closeOptionDialog();
            await this.render();
            return;
          }
          this.stremioAuthTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
        } catch (error) {
          await fail(error);
        }
      };
      this.stremioAuthTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    } catch (error) {
      await fail(error);
    }
  })();
}

export function registerStremioAccountActions() {
  this.actionMap.set("integration:stremio:account", () => {
    if (!StremioAccount.connected()) {
      openStremioAuthorization.call(this);
      return;
    }
    const profileId = String(ProfileManager.getActiveProfileId());
    this.openOptionDialog({
      title: "Stremio",
      message: StremioAccount.email() || "",
      options: [
        { id: "sync", label: t("simkl_sync_now") },
        { id: "addons", label: t("stremio_import_addons", {}, "Import my Stremio addons") },
        { id: "disconnect", label: t("debrid_disconnect") },
        { id: "cancel", label: t("common.cancel") }
      ],
      returnFocusKey: "integration:stremio:account",
      onSelect: async (option) => {
        if (String(ProfileManager.getActiveProfileId()) !== profileId) return true;
        try {
          if (option.id === "sync") {
            await StremioAccount.refresh({ force: true });
            this.stremioAccountMessage = t("stremio_synced", {}, "Stremio library synced.");
          } else if (option.id === "addons") {
            const added = await StremioAccount.importAddons(addonRepository);
            this.stremioAccountMessage = t(
              "stremio_addons_imported",
              [added],
              `${added} addon(s) imported from Stremio.`
            );
          } else if (option.id === "disconnect") {
            StremioAccount.disconnect();
            this.stremioAccountMessage = null;
          }
        } catch (error) {
          this.stremioAccountMessage = String(
            error?.message || t("stremio_unavailable", {}, "Unable to reach Stremio. Try again.")
          );
        }
        return true;
      }
    });
  });
}
