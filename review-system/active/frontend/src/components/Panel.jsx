import { forwardRef } from 'react'

const Panel = forwardRef(function Panel({ children, className = '' }, ref) {
  return (
    <div ref={ref} className={`review-panel ${className}`}>
      {children}
    </div>
  )
})

export default Panel
