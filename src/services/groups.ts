import { randomUUID } from "node:crypto";
import { SQLiteDatabase } from "../db/database";
import { conflict, forbidden, notFound, validation } from "../domain/errors";

export interface CreateGroupInput {
  ownerUserId: string;
  name: string;
  description?: string;
  simplifyDebts?: boolean;
}

export interface Group {
  id: string;
  name: string;
  description?: string;
  ownerUserId: string;
  ownerMemberId: string;
  simplifyDebts: boolean;
}

export interface MembershipGroup {
  groupId: string;
  name: string;
  role: string;
  memberId: string;
  simplifyDebts: boolean;
}

export interface AddMemberInput {
  groupId: string;
  actorMemberId: string;
  userId: string;
  role?: string;
}

export interface Member {
  memberId: string;
  groupId: string;
  userId: string;
  role: string;
  status: string;
}

export interface RosterMember extends Member {
  displayName: string;
}

type MemberRow = {
  id: string;
  status: string;
  role: string;
  archived_at: string | null;
};

export class GroupService {
  public constructor(private readonly database: SQLiteDatabase) {}

  public create(input: CreateGroupInput): Group {
    const ownerUserId = input.ownerUserId.trim();
    const name = input.name.trim();
    const description = input.description?.trim() || undefined;
    if (!ownerUserId) {
      throw validation("owner_user_id is required");
    }
    if (!name) {
      throw validation("name is required");
    }

    const group: Group = {
      id: randomUUID(),
      name,
      description,
      ownerUserId,
      ownerMemberId: randomUUID(),
      simplifyDebts: input.simplifyDebts ?? true,
    };
    const eventId = randomUUID();

    const createGroup = this.database.transaction(() => {
      const user = this.database
        .prepare(`SELECT 1 AS value FROM users WHERE id = ? AND deleted_at IS NULL`)
        .get(ownerUserId) as { value: number } | undefined;
      if (!user) {
        throw notFound("owner user was not found");
      }

      this.database
        .prepare(`
          INSERT INTO groups (
            id, name, description, created_by_user_id, simplify_debts
          )
          VALUES (@id, @name, @description, @ownerUserId, @simplifyDebts)
        `)
        .run({
          id: group.id,
          name: group.name,
          description: group.description ?? null,
          ownerUserId: group.ownerUserId,
          simplifyDebts: group.simplifyDebts ? 1 : 0,
        });
      this.database
        .prepare(`
          INSERT INTO group_members (id, group_id, user_id, role)
          VALUES (?, ?, ?, 'owner')
        `)
        .run(group.ownerMemberId, group.id, group.ownerUserId);
      this.database
        .prepare(`
          INSERT INTO activity_events (
            id, group_id, actor_member_id, entity_type, entity_id, action, after_json
          )
          VALUES (?, ?, ?, 'group', ?, 'created', ?)
        `)
        .run(
          eventId,
          group.id,
          group.ownerMemberId,
          group.id,
          JSON.stringify({ group_id: group.id, name: group.name, role: "owner" }),
        );
    });
    createGroup();
    return group;
  }

  public listForUser(userId: string): MembershipGroup[] {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw validation("user_id is required");
    }
    const rows = this.database
      .prepare(`
        SELECT g.id AS group_id, g.name, gm.role, gm.id AS member_id,
               g.simplify_debts
        FROM groups AS g
        JOIN group_members AS gm ON gm.group_id = g.id
        WHERE gm.user_id = ?
          AND gm.status = 'active'
          AND g.archived_at IS NULL
        ORDER BY g.updated_at DESC, g.id
      `)
      .all(normalizedUserId) as Array<{
      group_id: string;
      name: string;
      role: string;
      member_id: string;
      simplify_debts: number;
    }>;

    return rows.map((row) => ({
      groupId: row.group_id,
      name: row.name,
      role: row.role,
      memberId: row.member_id,
      simplifyDebts: row.simplify_debts === 1,
    }));
  }

  /**
   * This direct add is a local bootstrap shortcut. The production flow should
   * create an invitation and call the same membership logic after acceptance.
   */
  public addMember(input: AddMemberInput): Member {
    const groupId = input.groupId.trim();
    const actorMemberId = input.actorMemberId.trim();
    const userId = input.userId.trim();
    const role = input.role?.trim().toLowerCase() || "member";
    if (!groupId || !actorMemberId || !userId) {
      throw validation("group_id, actor_member_id, and user_id are required");
    }
    if (role !== "member" && role !== "admin") {
      throw validation("role must be member or admin");
    }

    const eventId = randomUUID();
    const addMember = this.database.transaction(() => {
      const actor = this.database
        .prepare(`
          SELECT gm.role, gm.status, g.archived_at
          FROM group_members AS gm
          JOIN groups AS g ON g.id = gm.group_id
          WHERE gm.group_id = ? AND gm.id = ?
        `)
        .get(groupId, actorMemberId) as MemberRow | undefined;
      if (!actor) {
        throw notFound("actor membership was not found");
      }
      if (actor.status !== "active" || !["owner", "admin"].includes(actor.role)) {
        throw forbidden("only an active admin or owner can add members");
      }
      if (actor.archived_at) {
        throw forbidden("group is archived");
      }

      const user = this.database
        .prepare(`SELECT 1 AS value FROM users WHERE id = ? AND deleted_at IS NULL`)
        .get(userId) as { value: number } | undefined;
      if (!user) {
        throw notFound("user was not found");
      }

      const existing = this.database
        .prepare(`
          SELECT id, status
          FROM group_members
          WHERE group_id = ? AND user_id = ?
        `)
        .get(groupId, userId) as { id: string; status: string } | undefined;
      if (existing?.status === "active") {
        throw conflict("user is already an active group member");
      }

      const memberId = existing?.id ?? randomUUID();
      if (existing) {
        this.database
          .prepare(`
            UPDATE group_members
            SET role = ?, status = 'active', left_at = NULL
            WHERE group_id = ? AND user_id = ?
          `)
          .run(role, groupId, userId);
      } else {
        this.database
          .prepare(`
            INSERT INTO group_members (id, group_id, user_id, role)
            VALUES (?, ?, ?, ?)
          `)
          .run(memberId, groupId, userId, role);
      }

      const member: Member = {
        memberId,
        groupId,
        userId,
        role,
        status: "active",
      };
      this.database
        .prepare(`
          INSERT INTO activity_events (
            id, group_id, actor_member_id, entity_type, entity_id, action, after_json
          )
          VALUES (?, ?, ?, 'member', ?, 'joined', ?)
        `)
        .run(eventId, groupId, actorMemberId, memberId, JSON.stringify(member));
      return member;
    });

    return addMember();
  }

  /**
   * The group roster, including members who left so historical splits stay
   * readable. Clients use this to render payer and participant choices.
   */
  public listMembers(groupId: string): RosterMember[] {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) {
      throw validation("group id is required");
    }
    const group = this.database
      .prepare(`SELECT 1 AS value FROM groups WHERE id = ?`)
      .get(normalizedGroupId) as { value: number } | undefined;
    if (!group) {
      throw notFound("group was not found");
    }

    const rows = this.database
      .prepare(`
        SELECT gm.id AS member_id, gm.group_id, gm.user_id, gm.role, gm.status,
               u.display_name
        FROM group_members AS gm
        JOIN users AS u ON u.id = gm.user_id
        WHERE gm.group_id = ?
        ORDER BY (gm.status = 'active') DESC,
                 u.display_name COLLATE NOCASE,
                 gm.id
      `)
      .all(normalizedGroupId) as Array<{
      member_id: string;
      group_id: string;
      user_id: string;
      role: string;
      status: string;
      display_name: string;
    }>;

    return rows.map((row) => ({
      memberId: row.member_id,
      groupId: row.group_id,
      userId: row.user_id,
      role: row.role,
      status: row.status,
      displayName: row.display_name,
    }));
  }
}
