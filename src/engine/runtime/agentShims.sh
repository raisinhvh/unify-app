# Unify agent shell, loaded through BASH_ENV (see rustTools.ts).
#
# Runs the user's own BASH_ENV first. Then, in `bash -c` shells (the ones agents run commands in), grep, egrep,
# fgrep, find and sed become functions that run rg, fd or sd when the arguments translate exactly, and the real
# Git Bash tool for anything else. Results must match the real tool, so a shim falls back whenever unsure:
#   grep  common flags, BRE and ERE patterns, -P, -r/-R, --include/--exclude/--exclude-dir
#   find  [-L] [paths] with one -name/-iname, -type f|d|l, -maxdepth, -mindepth, -print
#   sed   one s<delim>pattern<delim>replacement<delim>g[I] command, optionally with -i and -E/-r
# The translation is plain string handling. Nothing here calls a model.

[ -n "$UNIFY_USER_BASH_ENV" ] && [ -f "$UNIFY_USER_BASH_ENV" ] && . "$UNIFY_USER_BASH_ENV"

if [[ $- == *c* ]] && command -v rg >/dev/null 2>&1 && command -v fd >/dev/null 2>&1 && command -v sd >/dev/null 2>&1; then

# Runs a native tool without MSYS rewriting its arguments (a pattern like "/api" would become a Windows path).
__unify_native() {
	MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$@"
}

# Converts MSYS absolute paths (/c/x, /tmp) to C:/x for the native tools; relative paths pass through.
# Sets the array __unify_paths, and __unify_restore_from/__unify_restore_to with each converted pair.
__unify_convert_paths() {
	__unify_paths=()
	__unify_restore_from=()
	__unify_restore_to=()
	local path converted
	for path in "$@"; do
		converted=$path
		if [[ $path == /* ]]; then
			converted=$(cygpath -m "$path") || return 1
			if [[ $converted != "$path" ]]; then
				__unify_restore_from+=("$converted")
				__unify_restore_to+=("$path")
			fi
		fi
		__unify_paths+=("$converted")
	done
}

# Escapes $1 for a Rust regex into __unify_escaped.
__unify_escape_regex() {
	local text=${1//\\/\\\\}
	local char
	for char in . '[' ']' '(' ')' '{' '}' '*' + '?' '^' '$' '|'; do
		text=${text//"$char"/\\$char}
	done
	__unify_escaped=$text
}

# Reads tool output and turns converted paths at line starts back into the MSYS form the caller typed.
# $1 is the index of the pair to restore; each pair is one sd stage.
__unify_restore_stage() {
	local index=$1
	__unify_escape_regex "${__unify_restore_from[index]}"
	local to=${__unify_restore_to[index]//\\/\\\\}
	to=${to//\$/\$\$}
	if (( index + 1 < ${#__unify_restore_from[@]} )); then
		__unify_native sd -f m -- "^$__unify_escaped" "$to" | __unify_restore_stage $(( index + 1 ))
	else
		__unify_native sd -f m -- "^$__unify_escaped" "$to"
	fi
}

# Runs a native tool on converted paths, printing paths the way the real tool would. Returns the tool's status.
__unify_run_restoring() {
	if (( ! ${#__unify_restore_from[@]} )); then
		__unify_native "$@"
		return
	fi
	__unify_native "$@" | __unify_restore_stage 0
	return "${PIPESTATUS[0]}"
}

# Copies a bracket expression starting at index $2 of $1 into __unify_re. POSIX brackets treat backslash, "[" and
# set operators literally, so those are escaped for the Rust regex syntax. Sets __unify_bracket_end to the index
# after "]". Fails on an unterminated bracket.
__unify_copy_bracket() {
	local text=$1
	local index=$(( $2 + 1 ))
	local length=${#text}
	local char
	__unify_re+='['
	if [[ ${text:index:1} == '^' ]]; then
		__unify_re+='^'
		(( index++ ))
	fi
	if [[ ${text:index:1} == ']' ]]; then
		__unify_re+='\]'
		(( index++ ))
	fi
	while (( index < length )); do
		char=${text:index:1}
		if [[ $char == ']' ]]; then
			__unify_re+=']'
			__unify_bracket_end=$(( index + 1 ))
			return 0
		fi
		if [[ $char == '[' ]]; then
			local kind=${text:index+1:1}
			if [[ $kind == ':' || $kind == '.' || $kind == '=' ]]; then
				local rest=${text:index+2}
				local close="${kind}]"
				[[ $rest == *"$close"* ]] || return 1
				local inner=${rest%%"$close"*}
				[[ $kind == ':' ]] || return 1
				__unify_re+="[:${inner}:]"
				(( index += ${#inner} + 4 ))
				continue
			fi
			__unify_re+='\['
		elif [[ $char == '\' || $char == '&' || $char == '~' ]]; then
			__unify_re+="\\$char"
		else
			__unify_re+=$char
		fi
		(( index++ ))
	done
	return 1
}

# Rewrites a POSIX regex for rg and sd. $1 is bre or ere, $2 the pattern, $3 "sed" to allow \n and \t (sed reads
# them as newline and tab; grep does not). Sets __unify_re, or fails for constructs with no exact match, such as
# back-references and unknown escapes.
__unify_regex() {
	local dialect=$1
	local text=$2
	local for_sed=$3
	local length=${#text}
	local index=0
	local at_start=1
	local char next
	__unify_re=''
	while (( index < length )); do
		char=${text:index:1}
		if [[ $char == '\' ]]; then
			next=${text:index+1:1}
			(( index += 2 ))
			case $next in
				'')
					return 1
					;;
				[1-9])
					return 1
					;;
				'|' | '(' | ')' | '{' | '}' | '+' | '?')
					if [[ $dialect == bre ]]; then
						__unify_re+=$next
					else
						__unify_re+="\\$next"
					fi
					if [[ $next == '(' || $next == '|' ]]; then
						at_start=1
					else
						at_start=0
					fi
					continue
					;;
				'<' | '>')
					__unify_re+='\b'
					;;
				w | W | s | S | b | B)
					__unify_re+="\\$next"
					;;
				n | t)
					[[ $for_sed == sed ]] || return 1
					__unify_re+="\\$next"
					;;
				'.' | '*' | '[' | ']' | '^' | '$' | '\')
					__unify_re+="\\$next"
					;;
				[a-zA-Z0-9])
					return 1
					;;
				*)
					__unify_re+=$next
					;;
			esac
			at_start=0
			continue
		fi
		case $char in
			'[')
				__unify_copy_bracket "$text" "$index" || return 1
				index=$__unify_bracket_end
				at_start=0
				continue
				;;
			'*')
				if [[ $dialect == bre && $at_start == 1 ]]; then
					__unify_re+='\*'
				else
					__unify_re+='*'
				fi
				;;
			'^')
				if [[ $dialect == bre && $at_start != 1 ]]; then
					__unify_re+='\^'
				else
					__unify_re+='^'
					(( index++ ))
					continue
				fi
				;;
			'$')
				local after=${text:index+1:2}
				if [[ $dialect == ere || $index == $(( length - 1 )) || $after == '\)' || $after == '\|' ]]; then
					__unify_re+='$'
				else
					__unify_re+='\$'
				fi
				;;
			'|' | '(' | ')' | '{' | '}' | '+' | '?')
				if [[ $dialect == bre ]]; then
					__unify_re+="\\$char"
				else
					__unify_re+=$char
					if [[ $char == '(' || $char == '|' ]]; then
						(( index++ ))
						at_start=1
						continue
					fi
				fi
				;;
			*)
				__unify_re+=$char
				;;
		esac
		at_start=0
		(( index++ ))
	done
	return 0
}

# grep, egrep and fgrep through rg. $1 is the starting dialect: G (basic), E (extended) or F (fixed strings).
__unify_grep() {
	local mode=$1
	shift
	local -a real=(grep)
	[[ $mode == E ]] && real=(grep -E)
	[[ $mode == F ]] && real=(grep -F)
	local -a original=("$@")
	local -a flags=()
	local -a patterns=()
	local -a paths=()
	local recursive=0
	local have_pattern=0
	local options_done=0
	local bad=0
	local arg rest letter value pattern path

	while (( $# )); do
		arg=$1
		shift
		if (( options_done )) || [[ $arg != -?* ]]; then
			if (( have_pattern )); then
				paths+=("$arg")
			else
				patterns+=("$arg")
				have_pattern=1
			fi
			continue
		fi
		case $arg in
			--) options_done=1 ;;
			--regexp=*) patterns+=("${arg#*=}"); have_pattern=1 ;;
			--include=*) flags+=(-g "${arg#*=}") ;;
			--exclude=* | --exclude-dir=*) flags+=(-g "!${arg#*=}") ;;
			--color | --colour | --color=* | --colour=*) ;;
			--ignore-case) flags+=(-i) ;;
			--invert-match) flags+=(-v) ;;
			--word-regexp) flags+=(-w) ;;
			--line-regexp) flags+=(-x) ;;
			--line-number) flags+=(-n) ;;
			--count) flags+=(-c --include-zero) ;;
			--files-with-matches) flags+=(-l) ;;
			--files-without-match) flags+=(--files-without-match) ;;
			--only-matching) flags+=(-o) ;;
			--quiet | --silent) flags+=(-q) ;;
			--no-messages) flags+=(--no-messages) ;;
			--with-filename) flags+=(-H) ;;
			--no-filename) flags+=(-I) ;;
			--fixed-strings) mode=F ;;
			--extended-regexp) mode=E ;;
			--basic-regexp) mode=G ;;
			--perl-regexp) mode=P ;;
			--recursive) recursive=1 ;;
			--dereference-recursive) recursive=1; flags+=(-L) ;;
			--max-count=* | --after-context=* | --before-context=* | --context=*)
				value=${arg#*=}
				if [[ ! $value =~ ^[0-9]+$ ]]; then
					bad=1
					break
				fi
				case $arg in
					--max-count=*) flags+=(-m "$value") ;;
					--after-context=*) flags+=(-A "$value") ;;
					--before-context=*) flags+=(-B "$value") ;;
					*) flags+=(-C "$value") ;;
				esac
				;;
			--*)
				bad=1
				break
				;;
			-[0-9]*)
				if [[ ! $arg =~ ^-[0-9]+$ ]]; then
					bad=1
					break
				fi
				flags+=(-C "${arg#-}")
				;;
			*)
				rest=${arg#-}
				while [[ -n $rest ]]; do
					letter=${rest:0:1}
					rest=${rest:1}
					case $letter in
						i | y) flags+=(-i) ;;
						v | w | x | n | o | q | l | H) flags+=("-$letter") ;;
						c) flags+=(-c --include-zero) ;;
						L) flags+=(--files-without-match) ;;
						s) flags+=(--no-messages) ;;
						h) flags+=(-I) ;;
						I) ;;
						F | E | G | P) mode=$letter ;;
						r) recursive=1 ;;
						R) recursive=1; flags+=(-L) ;;
						A | B | C | m | e)
							if [[ -n $rest ]]; then
								value=$rest
								rest=''
							elif (( $# )); then
								value=$1
								shift
							else
								bad=1
								break 2
							fi
							if [[ $letter == e ]]; then
								patterns+=("$value")
								have_pattern=1
							elif [[ $value =~ ^[0-9]+$ ]]; then
								flags+=("-$letter" "$value")
							else
								bad=1
								break 2
							fi
							;;
						*)
							bad=1
							break 2
							;;
					esac
				done
				;;
		esac
	done

	(( have_pattern )) || bad=1
	local -a rg_args=(--no-config --no-heading --color never --path-separator /)
	if (( ! bad )); then
		case $mode in
			F) rg_args+=(-F) ;;
			P) rg_args+=(-P) ;;
		esac
		for pattern in "${patterns[@]}"; do
			case $mode in
				G) __unify_regex bre "$pattern" || { bad=1; break; } ;;
				E) __unify_regex ere "$pattern" || { bad=1; break; } ;;
				*) __unify_re=$pattern ;;
			esac
			rg_args+=(-e "$__unify_re")
		done
	fi
	# grep words its own errors for missing paths, and without -r reports a directory operand instead of searching it.
	if (( ! bad )); then
		for path in "${paths[@]}"; do
			[[ -e $path && ( $recursive == 1 || ! -d $path ) ]] || bad=1
		done
	fi
	if (( ! bad )); then
		__unify_convert_paths "${paths[@]}" || bad=1
	fi
	if (( bad )); then
		command "${real[@]}" "${original[@]}"
		return
	fi

	rg_args+=("${flags[@]}")
	if (( recursive )); then
		# grep -r searches hidden and ignored files too.
		rg_args+=(--no-ignore --hidden)
		if (( ${#__unify_paths[@]} )); then
			__unify_run_restoring rg "${rg_args[@]}" -- "${__unify_paths[@]}"
		else
			# With no path rg would read a piped stdin instead of the folder, as grep -r does not.
			__unify_native rg "${rg_args[@]}" </dev/null
		fi
	elif (( ${#__unify_paths[@]} )); then
		__unify_run_restoring rg "${rg_args[@]}" -- "${__unify_paths[@]}"
	else
		__unify_native rg "${rg_args[@]}" -
	fi
}

grep() { __unify_grep G "$@"; }
egrep() { __unify_grep E "$@"; }
fgrep() { __unify_grep F "$@"; }

# find through fd.
find() {
	local -a original=("$@")
	local -a roots=()
	local follow=0
	local name=''
	local name_option=''
	local type=''
	local max_depth=''
	local min_depth=''
	local bad=0
	local arg

	while [[ $1 == -H || $1 == -L || $1 == -P ]]; do
		[[ $1 == -L ]] && follow=1
		[[ $1 == -P ]] && follow=0
		shift
	done
	while (( $# )) && [[ $1 != -* && $1 != '(' && $1 != '!' ]]; do
		roots+=("$1")
		shift
	done
	(( ${#roots[@]} )) || roots=(.)
	while (( $# )); do
		arg=$1
		shift
		case $arg in
			-name | -iname)
				if (( ! $# )) || [[ -n $name_option || $1 == */* || $1 == *'\'* || $1 == *'{'* ]]; then
					bad=1
					break
				fi
				name=$1
				name_option=$arg
				shift
				;;
			-type)
				if (( ! $# )) || [[ -n $type || ! $1 =~ ^[fdl]$ ]]; then
					bad=1
					break
				fi
				type=$1
				shift
				;;
			-maxdepth | -mindepth)
				if (( ! $# )) || [[ ! $1 =~ ^[0-9]+$ ]]; then
					bad=1
					break
				fi
				if [[ $arg == -maxdepth ]]; then
					max_depth=$1
				else
					min_depth=$1
				fi
				shift
				;;
			-print) ;;
			*)
				bad=1
				break
				;;
		esac
	done
	local root
	if (( ! bad )); then
		# fd only searches folders; find on a file or a missing path has its own output.
		for root in "${roots[@]}"; do
			[[ -d $root ]] || bad=1
		done
	fi
	if (( ! bad )); then
		__unify_convert_paths "${roots[@]}" || bad=1
	fi
	if (( bad )); then
		command find "${original[@]}"
		return
	fi

	local -a fd_args=(-u --color never --path-separator / --format '{}')
	(( follow )) && fd_args+=(-L)
	[[ -n $type ]] && fd_args+=(-t "$type")
	[[ -n $max_depth ]] && fd_args+=(--max-depth "$max_depth")
	[[ -n $min_depth ]] && fd_args+=(--min-depth "$min_depth")
	if [[ $name_option == -iname ]]; then
		fd_args+=(-g -i)
	elif [[ -n $name_option ]]; then
		fd_args+=(-g -s)
	fi

	local status=0
	local index base
	for index in "${!roots[@]}"; do
		root=${roots[index]}
		# find lists the starting folder itself when it passes the tests; fd never does.
		if [[ ( -z $min_depth || $min_depth == 0 ) && ( -z $type || $type == d ) ]]; then
			base=$root
			while [[ $base == */ && $base != / ]]; do
				base=${base%/}
			done
			[[ $base != / ]] && base=${base##*/}
			if [[ -z $name_option ]]; then
				printf '%s\n' "$root"
			elif [[ $name_option == -iname ]]; then
				( shopt -s nocasematch; [[ $base == $name ]] ) && printf '%s\n' "$root"
			elif [[ $base == $name ]]; then
				printf '%s\n' "$root"
			fi
		fi
		[[ $max_depth == 0 ]] && continue
		__unify_run_restoring fd "${fd_args[@]}" -- "$name" "${__unify_paths[index]}" || status=$?
	done
	return $status
}

# sed through sd, for one global substitution.
sed() {
	local -a original=("$@")
	local -a files=()
	local in_place=0
	local extended=0
	local script=''
	local have_script=0
	local bad=0
	local arg

	while (( $# )); do
		arg=$1
		shift
		case $arg in
			--in-place) in_place=1 ;;
			--regexp-extended) extended=1 ;;
			-e | --expression)
				if (( ! $# || have_script )); then
					bad=1
					break
				fi
				script=$1
				have_script=1
				shift
				;;
			--expression=*)
				if (( have_script )); then
					bad=1
					break
				fi
				script=${arg#*=}
				have_script=1
				;;
			--)
				if (( ! have_script && $# )); then
					script=$1
					have_script=1
					shift
				fi
				files+=("$@")
				break
				;;
			-*)
				# Letters E/r and a final i (GNU reads letters after -i as a backup suffix).
				if [[ ! $arg =~ ^-[Er]*i?$ || $arg == - ]]; then
					bad=1
					break
				fi
				[[ $arg == *[Er]* ]] && extended=1
				[[ $arg == *i ]] && in_place=1
				;;
			*)
				if (( have_script )); then
					files+=("$arg")
				else
					script=$arg
					have_script=1
				fi
				;;
		esac
	done

	local delimiter pattern='' replacement='' flags char next index length
	if (( ! bad )) && [[ $script == s?* ]]; then
		delimiter=${script:1:1}
		length=${#script}
		[[ $delimiter == '\' || $delimiter == $'\n' ]] && bad=1
		index=2
		local part=0
		local -a pieces=('' '')
		while (( ! bad && index < length && part < 2 )); do
			char=${script:index:1}
			if [[ $char == '\' ]]; then
				next=${script:index+1:1}
				if [[ $next == "$delimiter" ]]; then
					# An escaped delimiter is that character, literally; regex characters are not worth the risk.
					if [[ $delimiter == [.\[\]*^\$\|\(\)\{\}+?\&] ]]; then
						bad=1
						break
					fi
					pieces[part]+=$delimiter
				else
					pieces[part]+="\\$next"
				fi
				(( index += 2 ))
				continue
			fi
			if [[ $char == "$delimiter" ]]; then
				(( part++ ))
			else
				pieces[part]+=$char
			fi
			(( index++ ))
		done
		(( part == 2 )) || bad=1
		pattern=${pieces[0]}
		replacement=${pieces[1]}
		flags=${script:index}
		[[ $flags =~ ^(g|gI|Ig|gi|ig)$ ]] || bad=1
		[[ -n $pattern ]] || bad=1
	else
		bad=1
	fi

	local -a sd_args=()
	if (( ! bad )); then
		[[ $flags == *[Ii]* ]] && sd_args+=(-f i)
		if (( extended )); then
			__unify_regex ere "$pattern" sed || bad=1
		else
			__unify_regex bre "$pattern" sed || bad=1
		fi
		pattern=$__unify_re
		# sd matches across the whole file, so anything that can match a newline would join lines.
		case $pattern in
			*'[^'* | *'\s'* | *'\W'* | *'\n'* | *'[:space:]'* | *'[:cntrl:]'*) bad=1 ;;
		esac
	fi
	if (( ! bad )); then
		# sed's & and \1 become ${0} and ${1}; $ is literal in sed and escaped for sd, which also unescapes \\ \n \t.
		local converted=''
		length=${#replacement}
		index=0
		while (( index < length )); do
			char=${replacement:index:1}
			if [[ $char == '\' ]]; then
				next=${replacement:index+1:1}
				case $next in
					[0-9]) converted+="\${$next}" ;;
					'&') converted+='&' ;;
					'\') converted+='\\' ;;
					n | t) converted+="\\$next" ;;
					'$') converted+='$$' ;;
					*)
						if [[ $next == [a-zA-Z] || -z $next ]]; then
							bad=1
							break
						fi
						converted+=$next
						;;
				esac
				(( index += 2 ))
				continue
			fi
			case $char in
				'&') converted+='${0}' ;;
				'$') converted+='$$' ;;
				*) converted+=$char ;;
			esac
			(( index++ ))
		done
		replacement=$converted
	fi
	local file
	if (( ! bad )); then
		(( in_place && ! ${#files[@]} )) && bad=1
		for file in "${files[@]}"; do
			[[ -f $file ]] || bad=1
		done
	fi
	if (( ! bad && in_place )); then
		__unify_convert_paths "${files[@]}" || bad=1
	fi
	if (( bad )); then
		command sed "${original[@]}"
		return
	fi

	if (( in_place )); then
		__unify_native sd "${sd_args[@]}" -- "$pattern" "$replacement" "${__unify_paths[@]}"
	elif (( ${#files[@]} )); then
		command cat -- "${files[@]}" | __unify_native sd "${sd_args[@]}" -- "$pattern" "$replacement"
	else
		__unify_native sd "${sd_args[@]}" -- "$pattern" "$replacement"
	fi
}

fi
