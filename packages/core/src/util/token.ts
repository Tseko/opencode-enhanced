export * as Token from "./token"

export const estimate = (input: string) => {
  if (!input) return 0
  let tokens = 0
  let letters = 0
  let digits = 0
  let index = 0
  while (index < input.length) {
    const code = input.charCodeAt(index)
    index++
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      if (digits) {
        tokens += Math.ceil(digits / 3)
        digits = 0
      }
      letters++
      if (letters < 4) continue
      tokens++
      letters = 0
      continue
    }
    if (code >= 48 && code <= 57) {
      if (letters) {
        tokens += Math.ceil(letters / 4)
        letters = 0
      }
      digits++
      if (digits < 3) continue
      tokens++
      digits = 0
      continue
    }
    if (letters) {
      tokens += Math.ceil(letters / 4)
      letters = 0
    }
    if (digits) {
      tokens += Math.ceil(digits / 3)
      digits = 0
    }
    tokens++
  }
  if (letters) tokens += Math.ceil(letters / 4)
  if (digits) tokens += Math.ceil(digits / 3)
  return tokens
}
