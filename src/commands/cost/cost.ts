import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { hasCodexAuth, isClaudeAISubscriber } from '../../utils/auth.js'

// GPT/Codex runs on a ChatGPT subscription (flat fee, not per token), so its
// usage carries no per-token dollar cost and is excluded from the total below.
const CODEX_COST_NOTE =
  'GPT/Codex usage runs on your ChatGPT subscription and is not included in the dollar total above.'

export const call: LocalCommandCall = async () => {
  const codexNote = hasCodexAuth() ? `\n\n${CODEX_COST_NOTE}` : ''

  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value: value + codexNote }
  }
  return { type: 'text', value: formatTotalCost() + codexNote }
}
