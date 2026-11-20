// Bold is written **like this** in a bold_markup text, across lines if need be. One parser, so what validation accepts is what the
// screen shows. Pure, and free of Node, because the browser uses it too.
export interface TextPart { text: string; bold: boolean }

export const textParts = (body: string): TextPart[] =>
  body.split(/\*\*(.+?)\*\*/s).map((text, i) => ({ text, bold: i % 2 === 1 })).filter((p) => p.text !== '')
