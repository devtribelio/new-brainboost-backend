import { describe, it, expect } from 'vitest';
import { toPlainText } from '@bb/common/utils/plain-text.util';

describe('toPlainText', () => {
  const cases: Array<[name: string, input: string, expected: string]> = [
    ['unwraps a single paragraph', '<p>p adu</p>', 'p adu'],
    ['keeps paragraphs apart instead of jamming them', '<p>a</p><p>b</p>', 'a b'],
    ['turns a line break into a space', 'baris satu<br>baris dua', 'baris satu baris dua'],
    [
      'keeps the mention text, drops the mention markup',
      '<p>Koh <span class="tb-editor-mention" data-member-id="57">@Denny-Santoso</span> apa kabar</p>',
      'Koh @Denny-Santoso apa kabar',
    ],
    // A 200-char excerpt slice routinely lands mid-tag.
    ['drops a tag the excerpt slice cut in half', '<p>halo dunia</p><span class="tb-e', 'halo dunia'],
    ['decodes the entities editor HTML leaves behind', 'ini&nbsp;&amp;&nbsp;itu', 'ini & itu'],
    ['decodes numeric references', 'Denny&#39;s tribe', "Denny's tribe"],
    ['collapses the whitespace tags leave behind', '<p>  a  </p>\n\n<p>b</p>', 'a b'],
    ['leaves plain text untouched', 'Parker mengomentari postinganmu', 'Parker mengomentari postinganmu'],
    ['returns empty for markup-only input', '<p></p><br>', ''],
    ['handles an empty string', '', ''],
    // "5 < 10" loses its bracket. Acceptable for a push preview, and the same
    // trade the stored-content sanitiser makes.
    ['drops a stray bracket', '5 < 10 > 2', '5 10 2'],
  ];

  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(toPlainText(input)).toBe(expected);
    });
  }

  // The output feeds an FCM body and an in-app list; neither should ever be
  // able to carry markup back, however the source encoded it.
  it('never lets an escaped tag decode back into markup', () => {
    const out = toPlainText('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('script alert(1) /script');
  });

  it('never lets a numeric-escaped tag decode back into markup', () => {
    expect(toPlainText('&#60;b&#62;tebal&#60;/b&#62;')).toBe('b tebal /b');
  });
});
