import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

/**
 * File-order sequencers for Wardroom's own green definition (SRS §3.4).
 *
 * The green definition runs the suite twice: once in file order and once in
 * reversed file order, because order dependencies between test files appear
 * silently and a single-order run cannot see them. Vitest's default sequencer
 * orders files by a size heuristic, which is neither stable nor reversible, so
 * both runs fix the order explicitly here (SDD §2, BACKLOG D-19).
 */

/** Ascending comparison on the module path, the "file order" both runs mean. */
function byModuleId(a: TestSpecification, b: TestSpecification): number {
  if (a.moduleId === b.moduleId) return 0;
  return a.moduleId < b.moduleId ? -1 : 1;
}

/** Ascending module-path order. Never mutates the given list. */
export function forwardFileOrder(files: readonly TestSpecification[]): TestSpecification[] {
  return [...files].sort(byModuleId);
}

/** Exactly the reverse of {@link forwardFileOrder}. Never mutates the given list. */
export function reversedFileOrder(files: readonly TestSpecification[]): TestSpecification[] {
  return forwardFileOrder(files).reverse();
}

/** Sequencer for the first verify command: the suite in file order. */
export class ForwardFileOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return forwardFileOrder(files);
  }
}

/** Sequencer for the second verify command: the same suite, file order reversed. */
export class ReversedFileOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return reversedFileOrder(files);
  }
}
