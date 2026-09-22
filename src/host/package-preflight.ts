import type { DevFlowStore } from './storage.ts'
import { createTaskPackage, type AgentTaskPackage, type TaskPackageOptions } from './protocol.ts'
import { validateTaskPackage } from './bridge.ts'
import type { Project, Task } from './types.ts'

/** The durable facts and validated package needed by every task handoff path. */
export interface TaskPackagePreflight {
  readonly task: Task
  readonly project: Project
  readonly package: AgentTaskPackage
}

/** Load, repair the goal, build, and validate one task package consistently. */
export async function prepareTaskPackage(
  store: DevFlowStore,
  taskId: string,
  options: TaskPackageOptions = {},
  onProjectUpdate?: (project: Project) => Promise<void>,
): Promise<TaskPackagePreflight> {
  const task = await store.getTask(taskId)
  if (task === undefined) throw new Error(`devflow: cannot export unknown task ${taskId}`)
  const current = await store.loadProject()
  if (current === undefined) throw new Error('devflow: no project initialized; save a project before building a task package')
  let project = current
  if (project.goal.trim() === '') {
    const goal = task.title.trim() || task.description.trim()
    if (goal === '') throw new Error(`devflow: cannot package task ${task.id} because project goal and task objective are empty`)
    project = { ...project, goal, updatedAt: new Date().toISOString() }
    await store.saveProject(project)
    await onProjectUpdate?.(project)
  }
  const pkg = createTaskPackage(task, project, options)
  const problems = validateTaskPackage(pkg)
  if (problems.length > 0) throw new Error(`Invalid AgentTaskPackage: ${problems.join('; ')}`)
  return { task, project, package: pkg }
}
