import { describe, expect, it } from 'vitest';
import { commentUpdate, postUpdate } from '../src/syncers/posts';

describe('posts syncer update branch', () => {
  it('does not revive a post the app deleted or rejected', () => {
    const update = postUpdate({ title: 't', content: 'c', isDeleted: false, publishStatus: 'PUBLISHED' });
    expect(update).toEqual({ title: 't', content: 'c' });
  });

  it('does not revive a comment the app deleted', () => {
    expect(commentUpdate({ content: 'c', isDeleted: false })).toEqual({ content: 'c' });
  });
});
