function castRoleLabel(role: string | null): string | null {
  if (!role) {
    return null;
  }
  if (role === 'MAIN' || role === 'SUPPORTING' || role === 'BACKGROUND') {
    return role;
  }
  return role.toUpperCase();
}

/** Display line for a character credit, e.g. `Yui Hirasawa (MAIN)`. */
export function formatCharacterCastCredit(
  characterName: string | null,
  characterRole: string | null,
): string {
  const name = characterName?.trim() || 'Character';
  const roleLabel = castRoleLabel(characterRole);
  if (roleLabel) {
    return `${name} (${roleLabel})`;
  }
  return name;
}
