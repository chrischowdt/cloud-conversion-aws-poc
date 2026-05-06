#!/usr/bin/env python3
"""
Project Architecture Overview Generator
Generates a compact, machine-readable index of all files and directories in the project,
including comprehensive code structure analysis (imports, exports, functions, classes, types).

Output format: Pipe-delimited (|) records for easy grep searching.
"""

import os
import sys
import re
from pathlib import Path
from typing import List, Tuple, Dict, Optional
from dataclasses import dataclass, field

# Directories to exclude from the tree
EXCLUDE_DIRS = {
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    '.cache',
    '__pycache__',
    '.pytest_cache',
    'coverage',
    '.nyc_output',
    'venv',
    'env',
    '.venv',
}

# File patterns to exclude
EXCLUDE_FILES = {
    '.DS_Store',
    'package-lock.json',
    'npm-debug.log',
    'yarn-error.log',
    '.env',
    '.env.local',
}

# Code file extensions to parse
CODE_EXTENSIONS = {
    '.ts', '.tsx', '.js', '.jsx',  # TypeScript/JavaScript
    '.py',                          # Python
    '.java',                        # Java
    '.go',                          # Go
    '.rs',                          # Rust
    '.c', '.cpp', '.h', '.hpp',     # C/C++
}

@dataclass
class FunctionInfo:
    """Information about a function or method."""
    name: str
    signature: str = ""
    is_async: bool = False
    is_exported: bool = False

@dataclass
class ClassInfo:
    """Information about a class."""
    name: str
    methods: List[FunctionInfo] = field(default_factory=list)
    is_exported: bool = False

@dataclass
class TypeInfo:
    """Information about TypeScript types/interfaces."""
    name: str
    kind: str  # 'interface', 'type', 'enum'
    is_exported: bool = False

@dataclass
class FileAnalysis:
    """Comprehensive analysis of a code file."""
    imports: List[str] = field(default_factory=list)  # Local imports only
    exports: List[str] = field(default_factory=list)
    classes: List[ClassInfo] = field(default_factory=list)
    functions: List[FunctionInfo] = field(default_factory=list)
    types: List[TypeInfo] = field(default_factory=list)  # interfaces, types, enums
    has_tests: bool = False

def should_exclude(name: str, is_dir: bool) -> bool:
    """Check if a file or directory should be excluded."""
    if is_dir:
        # Exclude hidden directories (starting with .)
        if name.startswith('.'):
            return True
        return name in EXCLUDE_DIRS
    return name in EXCLUDE_FILES

def check_has_tests(file_path: Path) -> bool:
    """Check if a test file exists for the given source file."""
    # Common test file patterns
    patterns = [
        file_path.with_suffix('.test' + file_path.suffix),
        file_path.with_suffix('.spec' + file_path.suffix),
        file_path.parent / '__tests__' / file_path.name,
        file_path.parent / '__tests__' / file_path.with_suffix('.test' + file_path.suffix).name,
        file_path.parent / '__tests__' / file_path.with_suffix('.spec' + file_path.suffix).name,
    ]

    return any(p.exists() for p in patterns)

def analyze_typescript_file(content: str, file_path: Path) -> FileAnalysis:
    """Analyze TypeScript/JavaScript file."""
    analysis = FileAnalysis()

    # Extract imports (local files only - starting with ./ or ../)
    import_pattern = r'import\s+.*?\s+from\s+[\'"](\.[^\'"]+)[\'"]'
    for match in re.finditer(import_pattern, content):
        import_path = match.group(1)
        analysis.imports.append(import_path)

    # Extract exports (named exports)
    export_pattern = r'export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)'
    for match in re.finditer(export_pattern, content):
        analysis.exports.append(match.group(1))

    # Extract default exports
    default_export_pattern = r'export\s+default\s+(\w+)'
    for match in re.finditer(default_export_pattern, content):
        analysis.exports.append(f"default: {match.group(1)}")

    # Extract interfaces
    interface_pattern = r'(export\s+)?interface\s+(\w+)'
    for match in re.finditer(interface_pattern, content):
        is_exported = match.group(1) is not None
        analysis.types.append(TypeInfo(
            name=match.group(2),
            kind='interface',
            is_exported=is_exported
        ))

    # Extract type aliases
    type_pattern = r'(export\s+)?type\s+(\w+)'
    for match in re.finditer(type_pattern, content):
        is_exported = match.group(1) is not None
        analysis.types.append(TypeInfo(
            name=match.group(2),
            kind='type',
            is_exported=is_exported
        ))

    # Extract enums
    enum_pattern = r'(export\s+)?enum\s+(\w+)'
    for match in re.finditer(enum_pattern, content):
        is_exported = match.group(1) is not None
        analysis.types.append(TypeInfo(
            name=match.group(2),
            kind='enum',
            is_exported=is_exported
        ))

    # Extract classes
    class_pattern = r'(export\s+)?class\s+(\w+)'
    for match in re.finditer(class_pattern, content):
        is_exported = match.group(1) is not None
        class_name = match.group(2)

        # Find class methods (simplified - looks for methods within ~500 chars of class declaration)
        class_pos = match.end()
        class_section = content[class_pos:class_pos+2000]
        method_pattern = r'(?:public|private|protected)?\s*(async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?\s*\{'
        methods = []
        for method_match in re.finditer(method_pattern, class_section):
            is_async = method_match.group(1) is not None
            method_name = method_match.group(2)
            params = method_match.group(3).strip()
            return_type = method_match.group(4).strip() if method_match.group(4) else ''

            # Skip constructor
            if method_name in ['constructor', class_name]:
                continue

            signature = f"({params})"
            if return_type:
                signature += f": {return_type}"

            methods.append(FunctionInfo(
                name=method_name,
                signature=signature,
                is_async=is_async,
                is_exported=False
            ))

        analysis.classes.append(ClassInfo(
            name=class_name,
            methods=methods,
            is_exported=is_exported
        ))

    # Extract standalone functions
    func_patterns = [
        r'(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^\{]+))?\s*\{',
        r'(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)(?:\s*:\s*([^\=\>]+))?\s*=>',
    ]

    for pattern in func_patterns:
        for match in re.finditer(pattern, content):
            groups = match.groups()
            if len(groups) == 5:  # function declaration
                is_exported = groups[0] is not None
                is_async = groups[1] is not None
                func_name = groups[2]
                params = groups[3].strip()
                return_type = groups[4].strip() if groups[4] else ''
            else:  # arrow function
                is_exported = groups[0] is not None
                func_name = groups[1]
                is_async = groups[2] is not None
                params = groups[3].strip()
                return_type = groups[4].strip() if groups[4] else ''

            signature = f"({params})"
            if return_type:
                signature += f": {return_type}"

            analysis.functions.append(FunctionInfo(
                name=func_name,
                signature=signature,
                is_async=is_async,
                is_exported=is_exported
            ))

    analysis.has_tests = check_has_tests(file_path)
    return analysis

def analyze_python_file(content: str, file_path: Path) -> FileAnalysis:
    """Analyze Python file."""
    analysis = FileAnalysis()

    # Extract imports (local/relative imports)
    import_pattern = r'from\s+(\.[^\s]+)\s+import'
    for match in re.finditer(import_pattern, content):
        analysis.imports.append(match.group(1))

    # Extract classes
    class_pattern = r'class\s+(\w+)'
    for match in re.finditer(class_pattern, content):
        class_name = match.group(1)

        # Find methods
        class_pos = match.end()
        class_section = content[class_pos:class_pos+2000]
        method_pattern = r'(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:'
        methods = []
        for method_match in re.finditer(method_pattern, class_section):
            is_async = 'async' in method_match.group(0)
            method_name = method_match.group(1)
            params = method_match.group(2).strip()
            return_type = method_match.group(3).strip() if method_match.group(3) else ''

            # Skip dunder methods except __init__
            if method_name.startswith('__') and method_name != '__init__':
                continue

            signature = f"({params})"
            if return_type:
                signature += f" -> {return_type}"

            methods.append(FunctionInfo(
                name=method_name,
                signature=signature,
                is_async=is_async,
                is_exported=False
            ))

        analysis.classes.append(ClassInfo(
            name=class_name,
            methods=methods,
            is_exported=False
        ))

    # Extract standalone functions
    func_pattern = r'(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:'
    for match in re.finditer(func_pattern, content):
        is_async = 'async' in match.group(0)
        func_name = match.group(1)
        params = match.group(2).strip()
        return_type = match.group(3).strip() if match.group(3) else ''

        # Skip if it's a method (already captured)
        if func_name in [m.name for c in analysis.classes for m in c.methods]:
            continue

        signature = f"({params})"
        if return_type:
            signature += f" -> {return_type}"

        analysis.functions.append(FunctionInfo(
            name=func_name,
            signature=signature,
            is_async=is_async,
            is_exported=False
        ))

    analysis.has_tests = check_has_tests(file_path)
    return analysis

def analyze_file(file_path: Path) -> Optional[FileAnalysis]:
    """
    Comprehensively analyze a code file.

    Args:
        file_path: Path to the code file

    Returns:
        FileAnalysis object or None if not a code file
    """
    ext = file_path.suffix.lower()

    if ext not in CODE_EXTENSIONS:
        return None

    try:
        with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        return None

    if ext in {'.ts', '.tsx', '.js', '.jsx'}:
        return analyze_typescript_file(content, file_path)
    elif ext == '.py':
        return analyze_python_file(content, file_path)
    else:
        # For other languages, return basic analysis
        return FileAnalysis(has_tests=check_has_tests(file_path))

def generate_compact_index(directory: Path, project_root: Path, output_file=None):
    """
    Generate a compact, machine-readable index of the directory with comprehensive code analysis.

    Format (pipe-delimited):
      FILE|relative_path|size_bytes|has_tests
      IMPORT|file_path|import_path
      EXPORT|file_path|export_name
      TYPE|file_path|type_name|kind|is_exported
      CLASS|file_path|class_name|is_exported
      METHOD|file_path|class_name|method_name|signature|is_async
      FUNC|file_path|function_name|signature|is_async|is_exported

    Args:
        directory: Path to the directory to map
        project_root: Path to project root for relative path calculation
        output_file: File object to write to (defaults to stdout)
    """
    if output_file is None:
        output_file = sys.stdout

    try:
        # Get all entries in the directory
        entries = sorted(directory.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))

        # Filter out excluded items
        entries = [e for e in entries if not should_exclude(e.name, e.is_dir())]

        for entry in entries:
            if entry.is_dir():
                # Recursively process subdirectory
                generate_compact_index(entry, project_root, output_file)
            else:
                # Get relative path from project root
                try:
                    rel_path = entry.relative_to(project_root)
                except ValueError:
                    rel_path = entry

                # Get file size
                size = entry.stat().st_size

                # Analyze code files
                analysis = analyze_file(entry)

                # Write file entry
                has_tests = "true" if analysis and analysis.has_tests else "false"
                output_file.write(f"FILE|{rel_path}|{size}|{has_tests}\n")

                # Write detailed analysis if available (same limits as old format)
                if analysis:
                    # Imports (limit 5, same as old format)
                    for import_path in analysis.imports[:5]:
                        output_file.write(f"IMPORT|{rel_path}|{import_path}\n")

                    # Exports (limit 10, same as old format)
                    for export_name in analysis.exports[:10]:
                        output_file.write(f"EXPORT|{rel_path}|{export_name}\n")

                    # Types/Interfaces/Enums (no limit, same as old format)
                    for type_info in analysis.types:
                        is_exported = "1" if type_info.is_exported else "0"
                        output_file.write(f"TYPE|{rel_path}|{type_info.name}|{type_info.kind}|{is_exported}\n")

                    # Classes (no limit, same as old format)
                    for class_info in analysis.classes:
                        is_exported = "1" if class_info.is_exported else "0"
                        output_file.write(f"CLASS|{rel_path}|{class_info.name}|{is_exported}\n")

                        # Methods of the class (limit 10, same as old format)
                        for method in class_info.methods[:10]:
                            is_async = "1" if method.is_async else "0"
                            output_file.write(f"METHOD|{rel_path}|{class_info.name}|{method.name}|{is_async}\n")

                    # Functions (limit 15, same as old format)
                    for func in analysis.functions[:15]:
                        is_async = "1" if func.is_async else "0"
                        is_exported = "1" if func.is_exported else "0"
                        output_file.write(f"FUNC|{rel_path}|{func.name}|{is_async}|{is_exported}\n")

    except PermissionError:
        output_file.write(f"ERROR|{directory}|Permission Denied\n")

def format_size(size_bytes: int) -> str:
    """Format file size in human-readable format."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024.0
    return f"{size_bytes:.1f}TB"

def count_items(directory: Path) -> Tuple[int, int]:
    """Count total files and directories (excluding hidden folders and their contents)."""
    total_files = 0
    total_dirs = 0

    def count_recursive(path: Path):
        nonlocal total_files, total_dirs
        try:
            for entry in path.iterdir():
                # Skip if excluded
                if should_exclude(entry.name, entry.is_dir()):
                    continue

                if entry.is_file():
                    total_files += 1
                elif entry.is_dir():
                    total_dirs += 1
                    # Recursively count subdirectory
                    count_recursive(entry)
        except PermissionError:
            pass

    count_recursive(directory)
    return total_files, total_dirs

def main():
    # Get the project root (1 level up from agent-tools/architecture-overview.py)
    script_path = Path(__file__).resolve()
    project_root = script_path.parent.parent

    # Output file path
    output_path = project_root / 'PROJECT_MAP.txt'

    print(f"Generating compact project map for: {project_root}")
    print(f"Output will be saved to: {output_path}")

    # Count items first
    print("Counting files and directories...")
    total_files, total_dirs = count_items(project_root)

    # Generate the compact index
    with open(output_path, 'w', encoding='utf-8') as f:
        # Write compact header (minimal)
        f.write(f"# PROJECT_MAP: {project_root.name}\n")
        f.write(f"# Total Directories: {total_dirs} | Total Files: {total_files}\n")
        f.write(f"# Excluded: Hidden dirs (.*), node_modules, dist, build, etc.\n")
        f.write(f"# Supported: TypeScript, JavaScript, Python\n")
        f.write(f"# Format: TYPE|field1|field2|...\n")
        f.write(f"#   FILE|path|size_bytes|has_tests\n")
        f.write(f"#   IMPORT|file|import_path\n")
        f.write(f"#   EXPORT|file|export_name\n")
        f.write(f"#   TYPE|file|name|kind|is_exported\n")
        f.write(f"#   CLASS|file|name|is_exported\n")
        f.write(f"#   METHOD|file|class|name|is_async\n")
        f.write(f"#   FUNC|file|name|is_async|is_exported\n")
        f.write(f"# ---\n")

        # Generate compact index
        generate_compact_index(project_root, project_root, f)

    print(f"\n✓ Compact project map generated successfully!")
    print(f"  Location: {output_path}")
    print(f"  Files: {total_files}")
    print(f"  Directories: {total_dirs}")

    # Show file size
    file_size = output_path.stat().st_size
    print(f"  Size: {format_size(file_size)}")

if __name__ == "__main__":
    main()