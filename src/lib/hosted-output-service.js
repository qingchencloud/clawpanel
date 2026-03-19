export function prepareHostedOutput(rawText, helpers, lastSentHash = '') {
  if (!rawText) return null
  const raw = String(rawText)
  const extracted = helpers.extractHostedAskUser(raw)
  const cleanedText = extracted.text || ''
  let displayText = cleanedText || '托管 Agent 发起用户提问'
  if (!displayText.startsWith('[托管 Agent]')) displayText = `[托管 Agent] ${displayText}`

  const instruction = helpers.extractHostedInstruction(cleanedText || raw)
  let instructionHash = ''
  let shouldSendInstruction = false
  if (instruction) {
    instructionHash = `${instruction.length}:${instruction.slice(0, 240)}:${instruction.slice(-80)}`
    shouldSendInstruction = instructionHash !== lastSentHash
  }

  return {
    extracted,
    cleanedText,
    displayText,
    instruction,
    instructionHash,
    shouldSendInstruction,
  }
}

export function buildHostedOptimisticUserMessage(answer, ts = Date.now()) {
  const finalAnswer = answer || ''
  return {
    message: {
      role: 'user',
      text: finalAnswer,
      content: finalAnswer,
      timestamp: ts,
    },
    storage: {
      role: 'user',
      content: finalAnswer,
      timestamp: ts,
    },
  }
}
