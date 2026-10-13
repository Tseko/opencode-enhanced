import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { AnimatedCountList, type CountItem } from "./tool-count-summary"

export function SessionThinking(props: {
  counts: CountItem[]
  startedAt?: number
  reasoningHeading?: string
  showReasoningSummaries: boolean
}) {
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const [now, setNow] = createSignal(Date.now())
  const elapsed = createMemo(() => {
    const startedAt = props.startedAt
    if (typeof startedAt !== "number") return ""
    const total = Math.max(0, Math.floor((now() - startedAt) / 1000))
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(Math.floor(total / 60)),
      seconds: numfmt().format(total % 60),
    })
  })
  // The preloader mounts only for a live turn, so the tick can follow its lifetime.
  createEffect(
    on(
      () => props.startedAt,
      (startedAt) => {
        if (typeof startedAt !== "number") return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
      },
    ),
  )

  return (
    <div data-slot="session-turn-thinking">
      <TextShimmer text={i18n.t("ui.sessionTurn.status.thinking")} />
      <Show when={elapsed()}>
        <span data-slot="session-turn-thinking-elapsed" class="shrink-0 font-normal text-text-weaker tabular-nums">
          {elapsed()}
        </span>
      </Show>
      <span
        data-slot="session-turn-thinking-counts"
        class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-weaker"
      >
        <AnimatedCountList items={props.counts} />
      </span>
      <Show when={!props.showReasoningSummaries}>
        <TextReveal text={props.reasoningHeading} class="session-turn-thinking-heading" travel={25} duration={700} />
      </Show>
    </div>
  )
}
