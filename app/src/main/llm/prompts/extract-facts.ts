export const EXTRACT_FACTS_INSTRUCTIONS = [
  "Extract only family facts stated by the user into the supplied JSON schema.",
  "Use only candidate IDs supplied in the input; report ambiguity in unresolvedReferences.",
  "Never emit SQL, file paths, commands, or write operations."
].join(" ");
