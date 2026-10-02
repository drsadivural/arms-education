/** Shared setup for learning tests: test context with in-memory storage + scanner, a seeded org and callers. */
import { bearerCaller, cookieCaller, createTestContext, type Caller, type TestContext } from "./app";
import { seedOrg, type OrgScenario } from "./fixtures";
import { FakeScanner, MemoryObjectStorage } from "./learning-fakes";
import type { Integrations } from "../../src/integrations";

export interface LearningWorld {
  ctx: TestContext;
  storage: MemoryObjectStorage;
  scanner: FakeScanner;
  org: OrgScenario;
  admin: Caller;
  teacher: Caller;
  otherTeacher: Caller;
  student: Caller;
  student2: Caller;
  otherStudent: Caller;
}

export async function learningWorld(opts: { storage?: boolean; scanner?: boolean; overrides?: Partial<Integrations> } = {}): Promise<LearningWorld> {
  const storage = new MemoryObjectStorage();
  const scanner = new FakeScanner(storage);
  const ctx = createTestContext({
    storage: opts.storage === false ? null : storage,
    scanner: opts.scanner === false ? null : scanner,
    ...(opts.overrides ?? {}),
  });
  const org = await seedOrg(ctx.admin);
  return {
    ctx,
    storage,
    scanner,
    org,
    admin: await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" }),
    teacher: await bearerCaller(org.teacher.userId, org.orgId),
    otherTeacher: await bearerCaller(org.otherTeacher.userId, org.orgId),
    student: await bearerCaller(org.student.userId, org.orgId),
    student2: await bearerCaller(org.student2.userId, org.orgId),
    otherStudent: await bearerCaller(org.otherStudent.userId, org.orgId),
  };
}

/** Another context sharing the same database (e.g. with no scanner configured). */
export function contextWith(overrides: Partial<Integrations>): TestContext {
  return createTestContext(overrides);
}
