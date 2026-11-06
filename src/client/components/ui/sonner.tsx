import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner theme="light" className="toaster group" richColors position="bottom-right" {...props} />
)

export { Toaster }
