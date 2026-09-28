export const EXTRACT_FACTS_INSTRUCTIONS = [
  "Extract only family facts stated by the user into the supplied JSON schema.",
  "For each person, put only explicitly stated mutable field names in statedFields; placeholder null, unknown, or empty values must not imply an update.",
  "A new person must explicitly state displayName and gender, using unknown gender only when the user explicitly says it is unknown.",
  "Use only candidate IDs supplied in the input; report ambiguity in unresolvedReferences.",
  "Never emit SQL, file paths, commands, or write operations."
].join(" ");
