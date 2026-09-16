import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Subscription } from "../models/Subscription.js";
import { ensureDefaultOrganization } from "./plans.js";
import { ensureSubscription } from "./subscriptions.js";

export const WORKSPACE_PROVISIONING_VERSION = 1;

function withSession(query, session) {
  return session ? query.session(session) : query;
}

function isStarterProject(project, organization, user) {
  return Boolean(
    project &&
    String(project.organization) === String(organization._id) &&
    project.members.some(
      (member) => String(member.user) === String(user._id) && member.role === "admin"
    )
  );
}

export async function provisionPersonalWorkspace(user, { session = null, now = new Date() } = {}) {
  let organization = user.personalOrganization
    ? await withSession(Organization.findById(user.personalOrganization), session)
    : null;

  if (!organization) {
    organization = await ensureDefaultOrganization(user, { session });
  }

  const existingSubscription = await withSession(
    Subscription.findOne({ organization: organization._id }),
    session
  );
  const subscription = await ensureSubscription(organization, {
    session,
    now,
    initialSource: "system",
    initialNote: "Тариф Free назначен при регистрации"
  });

  let project = user.starterProject
    ? await withSession(Project.findById(user.starterProject), session)
    : null;

  if (!isStarterProject(project, organization, user)) {
    project = await withSession(
      Project.findOne({
        organization: organization._id,
        createdBy: user._id,
        members: { $elemMatch: { user: user._id, role: "admin" } }
      }).sort({ createdAt: 1 }),
      session
    );
  }

  const isNewWorkspace = !project;
  if (!project) {
    const values = {
      organization: organization._id,
      name: "Проект",
      description: "",
      createdBy: user._id,
      members: [{ user: user._id, role: "admin" }],
      categories: []
    };
    if (session) {
      [project] = await Project.create([values], { session });
    } else {
      project = await Project.create(values);
    }
  }

  user.personalOrganization = organization._id;
  user.starterProject = project._id;
  user.workspaceProvisioningVersion = WORKSPACE_PROVISIONING_VERSION;
  await user.save(session ? { session } : undefined);

  return {
    organization,
    subscription,
    project,
    plan: subscription.currentPlan,
    isNewWorkspace: isNewWorkspace || !existingSubscription
  };
}
