"""Run the unmodified official WPT server using its vendored Python imports."""
import os
import sys
sys.path.insert(0, os.path.abspath(sys.argv.pop(1)))
import tools.localpaths
from serve import serve
if __name__ == '__main__':
    sys.exit(serve.main())
