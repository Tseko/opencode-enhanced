import { Show, Suspense, createEffect, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { DebugBar } from "@/components/debug-bar"
import { Titlebar, type TitlebarUpdate } from "@/components/titlebar"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { NewLayoutSidebar, NewLayoutSidebarCommands } from "@/pages/layout/new-layout-sidebar"

export default function NewLayout(props: ParentProps) {
  const platform = usePlatform()
  const layout = useLayout()
  const [state, setState] = createStore({ debugTools: true })
  const side = () => Math.max(layout.sidebar.width(), 244)

  createEffect(() => setV2Toast(true))

  const update: TitlebarUpdate = {
    version: () => {
      const state = platform.updater?.state()
      if (state?.status !== "ready") return
      return state.version
    },
    installing: () => platform.updater?.state().status === "installing",
    install: () => void platform.updater?.install(),
  }

  return (
    <div
      class="relative bg-v2-background-bg-deep flex-1 min-h-0 min-w-0 flex flex-col select-none [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        "padding-bottom": "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <NewLayoutSidebarCommands />
      <Titlebar
        update={update}
        debugTools={
          import.meta.env.DEV
            ? { visible: state.debugTools, toggle: () => setState("debugTools", (value) => !value) }
            : undefined
        }
      />
      <div class="flex min-h-0 flex-1">
        <Show when={layout.sidebar.opened()}>
          <div class="relative h-full shrink-0" style={{ width: `${side()}px` }}>
            <NewLayoutSidebar />
            <div class="absolute inset-y-0 end-0 z-30 w-0 overflow-visible">
              <ResizeHandle
                direction="horizontal"
                size={layout.sidebar.width()}
                min={244}
                max={typeof window === "undefined" ? 1000 : Math.max(320, window.innerWidth * 0.4)}
                onResize={(width) => layout.sidebar.resize(width)}
              />
            </div>
          </div>
        </Show>
        <main class="flex min-h-0 min-w-0 flex-1 flex-col items-start overflow-x-hidden contain-strict">
          <Suspense>{props.children}</Suspense>
        </main>
      </div>
      {import.meta.env.DEV && state.debugTools && <DebugBar inline />}
      <ToastRegion v2 />
    </div>
  )
}
