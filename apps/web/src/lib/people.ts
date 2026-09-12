export const ROLE_LABELS = { owner: "所有者", admin: "管理员", member: "成员" } as const;

export type Person = {
  id: string;
  email: string;
  name: string | null;
  title: string | null;
  bio: string | null;
  avatarRev: number;
  lastLoginAt: string | null;
  createdAt: string;
  role: keyof typeof ROLE_LABELS | string;
  joinedAt: string;
};

export function personName(person: Pick<Person, "name" | "email">) {
  return person.name?.trim() || person.email;
}
