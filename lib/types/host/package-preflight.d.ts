import type { DevFlowStore } from './storage.ts';
import { type AgentTaskPackage, type TaskPackageOptions } from './protocol.ts';
import type { Project, Task } from './types.ts';
/** The durable facts and validated package needed by every task handoff path. */
export interface TaskPackagePreflight {
    readonly task: Task;
    readonly project: Project;
    readonly package: AgentTaskPackage;
}
/** Load, repair the goal, build, and validate one task package consistently. */
export declare function prepareTaskPackage(store: DevFlowStore, taskId: string, options?: TaskPackageOptions, onProjectUpdate?: (project: Project) => Promise<void>): Promise<TaskPackagePreflight>;
