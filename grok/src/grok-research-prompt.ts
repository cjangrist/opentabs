export const FILE_ARTIFACT_INSTRUCTION =
  'CRITICAL INSTRUCTIONS: Write report as single markdown file to disk, then present the artifact to the user for download; DO NOT respond directly in chat. This is an in-depth research task and requires a single markdown downloadable file to be completed per instructions above.';

export const FILE_ARTIFACT_VERIFICATION_INSTRUCTION =
  "Use Grok's file-writing capability and attach exactly one native Markdown file card. The task is incomplete if you only claim that a file was saved or provide no download; verify that the file card is present before finishing.";

export const FILE_ARTIFACT_REPAIR_INSTRUCTION =
  'The required Markdown file attachment is missing. Do not repeat the research and do not summarize it in chat. Use the completed research from this conversation to create and attach exactly one native Markdown file card now, preserving the requested report content and filename.';

export const FILE_ARTIFACT_INSTRUCTION_BLOCK = `${FILE_ARTIFACT_INSTRUCTION}\n\n${FILE_ARTIFACT_VERIFICATION_INSTRUCTION}`;

export const hasFileArtifactInstruction = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.endsWith(FILE_ARTIFACT_INSTRUCTION) || trimmed.endsWith(FILE_ARTIFACT_INSTRUCTION_BLOCK);
};

const appendParagraph = (text: string, paragraph: string): string => {
  const separator = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${paragraph}`;
};

export const withFileArtifactInstruction = (text: string): string => {
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(FILE_ARTIFACT_INSTRUCTION_BLOCK)) return text;
  if (trimmed.endsWith(FILE_ARTIFACT_INSTRUCTION)) return appendParagraph(text, FILE_ARTIFACT_VERIFICATION_INSTRUCTION);
  return appendParagraph(text, FILE_ARTIFACT_INSTRUCTION_BLOCK);
};
