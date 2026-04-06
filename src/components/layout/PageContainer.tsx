import { motion } from 'framer-motion'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

const pageVariants = {
  initial: { opacity: 0, y: 8 },
  enter: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
}

const pageTransition = {
  duration: 0.2,
  ease: 'easeOut',
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">
          <motion.div
            variants={pageVariants}
            initial="initial"
            animate="enter"
            exit="exit"
            transition={pageTransition}
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  )
}
