import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ImageRefsPanel from '../src/components/ImageRefsPanel.jsx'

const im = (id, role, extra = {}) => ({ id, hash: `h-${id}`, fileName: `${id}.jpg`, previewUrl: 'data:image/jpeg;base64,QQ==', role, ...extra })
const render = (props) => renderToStaticMarkup(
  <ImageRefsPanel images={[]} max={4} roleOf={(x) => x.role || 'general'} imageMeta={{}} onAdd={() => {}} onRoleChange={() => {}} onRemove={() => {}} {...props} />)

describe('ImageRefsPanel', () => {
  it('shows the count and the add zone while under the cap', () => {
    const html = render({ images: [im('a', 'pose_composition')] })
    expect(html).toContain('1/4')
    expect(html).toContain('+ Add a reference image')
  })
  it('states what each role contributes', () => {
    const html = render({ images: [im('a', 'pose_composition'), im('b', 'general')] })
    expect(html).toContain('only the body pose and the framing only is taken from this image')
    expect(html).toContain('the whole image may inform the prompt')
  })
  it('hides the add zone at the cap', () => {
    const html = render({ images: [1, 2, 3, 4].map(n => im(`i${n}`, 'style')), max: 4 })
    expect(html).not.toContain('+ Add a reference image')
  })
  it('marks a role the image already has a description for', () => {
    const html = render({ images: [im('a', 'style')], imageMeta: { 'h-a': { captions: { style: 'teal' } } } })
    expect(html).toContain('Style — described')
  })
})
