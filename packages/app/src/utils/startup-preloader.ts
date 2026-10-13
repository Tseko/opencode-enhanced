const STARTUP_PRELOADER_ID = "oc-startup-preloader"

export function markStartupPreloaderReady() {
  if (typeof document !== "object") return

  document.documentElement.dataset.startupReady = "true"
  const preloader = document.getElementById(STARTUP_PRELOADER_ID)
  if (!preloader) return
  if (preloader.dataset.dismissed === "true") return

  preloader.dataset.dismissed = "true"
  preloader.setAttribute("aria-hidden", "true")
  const remove = () => preloader.remove()
  preloader.addEventListener("transitionend", remove, { once: true })
  window.setTimeout(remove, 240)
}
