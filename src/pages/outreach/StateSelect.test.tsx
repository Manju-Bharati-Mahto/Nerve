import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StateSelect from './StateSelect'

afterEach(cleanup)

const options = () => Array.from((screen.getByRole('combobox') as HTMLSelectElement).options)

describe('StateSelect', () => {
  it('offers the 28 states, 8 union territories and Pan India in groups — nothing typed', () => {
    render(<StateSelect value="" onChange={() => {}} aria-label="State" />)
    const groups = Array.from(document.querySelectorAll('optgroup'))
    expect(groups.map(g => [g.label, g.querySelectorAll('option').length])).toEqual([
      ['States', 28], ['Union territories', 8], ['Not one state', 1],
    ])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('shows a stored variant spelling as its canonical state', () => {
    render(<StateSelect value="  tamilnadu " onChange={() => {}} aria-label="State" />)
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('Tamil Nadu')
  })

  it('shows a value off the list as "unrecognised", not as some other state', () => {
    render(<StateSelect value="Guj" onChange={() => {}} aria-label="State" />)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('Guj')
    const legacy = options().find(o => o.value === 'Guj')
    expect(legacy?.disabled).toBe(true)
    expect(legacy?.textContent).toMatch(/unrecognised/)
    expect(select.getAttribute('aria-invalid')).toBe('true')
  })

  it('hands back the canonical name', () => {
    const onChange = vi.fn()
    render(<StateSelect value="" onChange={onChange} aria-label="State" />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Jammu and Kashmir' } })
    expect(onChange).toHaveBeenCalledWith('Jammu and Kashmir')
  })

  it('offers an empty choice only when asked (a campaign may have no state)', () => {
    render(<StateSelect value="" onChange={() => {}} allowEmpty="Not tied to one state" aria-label="State" />)
    const empty = options().find(o => o.value === '')
    expect(empty?.textContent).toBe('Not tied to one state')
    expect(empty?.disabled).toBe(false)
  })
})
